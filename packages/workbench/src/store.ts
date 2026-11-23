import { hasReplyContent } from "./reply-content.ts";
import { deliveredMessages } from "./delivery-messages.ts";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type {
  Ability, Artifact, Bot, BotSection, Conversation, FileBatch, Interaction, LastMessagePreview, Message, ProductEvent, ReadState, Run, ScratchpadItem,
  GroupInput, ProductSpace, ResultNotification, Snapshot, StoredReaction, SubmissionRecord, Task, TaskStatus,
} from "./contracts.ts";

const terminal = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const DEFAULT_SPACE_ID = "local";
const allowedKinds = new Set(["spaces", "botSections", "bots", "conversations", "tasks", "messages", "abilities", "artifacts", "runs", "submissions", "settings", "contextShares", "interactions", "routines", "routineReceipts", "notifications", "fileBatches", "readState", "reactions", "scratchpad", "voiceCredentials"]);

/** A message's own words for a sidebar row; a file or a question stands in when it has none. */
function messagePreviewText(message: Message): string {
  const text = message.blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join(" ")
    .trim();
  if (text) return text;
  for (const block of message.blocks) {
    if (block.kind === "file") return block.name;
    if (block.kind === "approval" || block.kind === "question") return block.title;
    if (block.kind === "widget") return block.title;
  }
  return "";
}

/** One local product journal. Engine storage stays behind the official Gateway API. */
export class WorkbenchStore extends EventEmitter {
  private readonly db: DatabaseSync;
  private transactionEvents: ProductEvent[] | undefined;

  constructor(path: string) {
    super();
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(kind,id)
      );
      CREATE INDEX IF NOT EXISTS records_conversation
        ON records(kind,json_extract(data,'$.conversationId'),created_at);
      CREATE INDEX IF NOT EXISTS records_engine_session
        ON records(kind,json_extract(data,'$.sessionKey'));
      CREATE INDEX IF NOT EXISTS records_task
        ON records(kind,json_extract(data,'$.taskId'));
      CREATE INDEX IF NOT EXISTS records_parent_task
        ON records(kind,json_extract(data,'$.parentTaskId'));
      CREATE INDEX IF NOT EXISTS records_routine
        ON records(kind,json_extract(data,'$.routineId'));
      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS engine_receipts (
        identity TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_engine_frames (
        identity TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        frame TEXT NOT NULL CHECK(json_valid(frame)),
        received_at INTEGER NOT NULL,
        associated INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  listSpaces(): ProductSpace[] {
    return [
      { id: DEFAULT_SPACE_ID, name: "本机", createdAt: 0 },
      ...this.list<ProductSpace>("spaces", -1).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    ];
  }

  createSpace(name: string): ProductSpace {
    const normalized = name.trim();
    if (!normalized || normalized.length > 60) throw new Error("空间名称需要为 1–60 个字符");
    if (this.listSpaces().some((space) => space.name === normalized)) throw new Error("已存在同名空间");
    return this.put("spaces", { id: randomUUID(), name: normalized, createdAt: Date.now() });
  }

  renameSpace(id: string, name: string): ProductSpace {
    if (id === DEFAULT_SPACE_ID) throw new Error("默认空间不能重命名");
    const current = this.get<ProductSpace>("spaces", id);
    if (!current) throw new Error("空间不存在");
    const normalized = name.trim();
    if (!normalized || normalized.length > 60) throw new Error("空间名称需要为 1–60 个字符");
    if (this.listSpaces().some((space) => space.id !== id && space.name === normalized)) throw new Error("已存在同名空间");
    return this.put("spaces", { ...current, name: normalized });
  }

  removeSpace(id: string): void {
    if (id === DEFAULT_SPACE_ID) throw new Error("默认空间不能删除");
    if (!this.get<ProductSpace>("spaces", id)) throw new Error("空间不存在");
    this.transaction(() => {
      for (const bot of this.list<Bot>("bots", -1).filter((entry) => (entry.spaceId ?? DEFAULT_SPACE_ID) === id)) {
        this.put("bots", { ...bot, spaceId: DEFAULT_SPACE_ID });
      }
      for (const conversation of this.list<Conversation>("conversations", -1)
        .filter((entry) => (entry.spaceId ?? DEFAULT_SPACE_ID) === id)) {
        this.put("conversations", { ...conversation, spaceId: DEFAULT_SPACE_ID });
      }
      for (const section of this.list<BotSection>("botSections", -1)
        .filter((entry) => (entry.spaceId ?? DEFAULT_SPACE_ID) === id)) {
        this.put("botSections", { ...section, spaceId: DEFAULT_SPACE_ID });
      }
      this.db.prepare("DELETE FROM records WHERE kind='spaces' AND id=?").run(id);
      this.recordEvent("spaces.removed", id, { id, movedTo: DEFAULT_SPACE_ID });
    });
  }

  spaceIdForBot(botId: string): string {
    const bot = this.get<Bot>("bots", botId);
    if (!bot) throw new Error("Unknown Bot");
    return bot.spaceId ?? DEFAULT_SPACE_ID;
  }

  transaction<T>(work: () => T): T {
    if (this.transactionEvents) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionEvents = [];
    let result: T;
    let events: ProductEvent[];
    try {
      result = work();
      this.db.exec("COMMIT");
      events = this.transactionEvents;
      this.transactionEvents = undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.transactionEvents = undefined;
      throw error;
    }
    // Subscriber errors happen after durability. They must never attempt to
    // roll back an already committed transaction or erase its event receipt.
    for (const event of events) this.emit("event", event);
    return result;
  }

  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }

  list<T>(kind: string, limit = 1000): T[] {
    return this.db.prepare("SELECT data FROM records WHERE kind=? AND (kind != 'bots' OR json_extract(data,'$.removedAt') IS NULL) ORDER BY created_at,id LIMIT ?")
      .all(kind, limit).map((row) => JSON.parse(String(row.data)) as T);
  }

  artifactPage(botId: string, before?: string, limit = 50): { files: Artifact[]; next?: string } {
    if (!this.get<Bot>("bots", botId)) throw new Error("Unknown Bot");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid file page size");
    const cursor = before ? this.db.prepare(`SELECT id,created_at FROM records
      WHERE kind='artifacts' AND id=? AND json_extract(data,'$.botId')=?`).get(before, botId) : undefined;
    if (before && !cursor) throw new Error("Invalid file cursor");
    const rows = cursor
      ? this.db.prepare(`SELECT id,data FROM records WHERE kind='artifacts' AND json_extract(data,'$.botId')=?
          AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(botId, cursor.created_at!, cursor.created_at!, cursor.id!, limit + 1)
      : this.db.prepare(`SELECT id,data FROM records WHERE kind='artifacts' AND json_extract(data,'$.botId')=?
          ORDER BY created_at DESC,id DESC LIMIT ?`).all(botId, limit + 1);
    const page = rows.slice(0, limit);
    return {
      files: page.map((row) => JSON.parse(String(row.data)) as Artifact),
      ...(rows.length > limit ? { next: String(page.at(-1)!.id) } : {}),
    };
  }

  find<T>(kind: string, field: "conversationId" | "taskId" | "sessionKey" | "parentTaskId" | "routineId", value: string): T[] {
    return this.db.prepare(`SELECT data FROM records WHERE kind=? AND json_extract(data,'$.${field}')=? ORDER BY created_at,id`)
      .all(kind, value).map((row) => JSON.parse(String(row.data)) as T);
  }

  tasksWithProcesses(): Task[] {
    // Resource cleanup must not inherit the UI inventory's pagination limit.
    return this.db.prepare(`SELECT data FROM records
      WHERE kind='tasks' AND json_array_length(json_extract(data,'$.processes'))>0
      ORDER BY created_at,id`).all().map((row) => JSON.parse(String(row.data)) as Task);
  }

  hasUnfinishedWork(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM records
      WHERE kind='tasks' AND (
        json_extract(data,'$.status') IN ('queued','running','waiting','stopping')
        OR EXISTS (SELECT 1 FROM json_each(records.data,'$.processes') AS process
          WHERE COALESCE(json_extract(process.value,'$.status'),'unknown') NOT IN ('completed','failed','killed'))
      ) LIMIT 1`).get());
  }

  memoryRecoveryReviews<T>(botId: string): T[] {
    return this.db.prepare(`SELECT data FROM records
      WHERE kind='settings' AND json_extract(data,'$.botId')=?
        AND json_extract(data,'$.recovery.scope')='kernel-and-selected-workspace'
      ORDER BY updated_at DESC,id LIMIT 50`).all(botId).map((row) => JSON.parse(String(row.data)) as T);
  }

  pendingMemoryReviews<T>(): T[] {
    return this.db.prepare(`SELECT data FROM records
      WHERE kind='settings' AND id LIKE 'memory-forget-%'
        AND json_extract(data,'$.report.dryRun')=1
        AND json_extract(data,'$.outcome') IS NULL
      ORDER BY created_at,id`).all().map((row) => JSON.parse(String(row.data)) as T);
  }

  put<T extends { id: string }>(kind: string, value: T, eventType = `${kind}.changed`): T {
    if (!allowedKinds.has(kind)) throw new Error("Invalid product record kind");
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare(`INSERT INTO records(kind,id,data,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
        .run(kind, value.id, JSON.stringify(value), now, now);
      // Voice credentials share the local database's protection, never its public
      // event journal. As with native model settings, clients receive metadata only.
      this.recordEvent(eventType, value.id, kind === "voiceCredentials" ? { id: value.id } : value);
      // A reply the reader has not acknowledged yet is unread from the moment it exists,
      // so the sidebar dot and the "New" divider come from the stored boundary.
      if (kind === "messages") this.noteArrival(value as unknown as Message);
      return value;
    });
  }

  /** Mark a conversation unread when a message arrives past its read boundary. */
  private noteArrival(message: Message): void {
    if (message.role !== "assistant" || !message.conversationId || !hasReplyContent(message.blocks, message.silent)) return;
    if (!message.final && this.get<Task>("tasks", message.taskId ?? "")?.routine &&
      !hasReplyContent(message.blocks.filter((block) => block.kind !== "text"))) return;
    const read = this.readState(message.conversationId);
    if (read.unread) return;
    this.put("readState", { ...read, unread: true, updatedAt: Date.now() }, "readState.changed");
  }

  recordEvent(type: string, entityId: string, data: unknown): ProductEvent {
    return this.transaction(() => {
      const now = Date.now();
      const result = this.db.prepare("INSERT INTO events(type,entity_id,data,created_at) VALUES(?,?,?,?)")
        .run(type, entityId, JSON.stringify(data), now);
      const event: ProductEvent = { cursor: Number(result.lastInsertRowid), type, entityId, data, createdAt: now };
      this.transactionEvents?.push(event);
      return event;
    });
  }

  acceptEngineFrame(identity: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO engine_receipts(identity,received_at) VALUES(?,?)")
      .run(identity, Date.now()).changes > 0;
  }

  retainUnassociatedFrame(identity: string, runId: string, generation: number, frame: unknown): void {
    this.db.prepare(`INSERT OR IGNORE INTO pending_engine_frames(identity,run_id,generation,frame,received_at)
      VALUES(?,?,?,?,?)`).run(identity, runId, generation, JSON.stringify(frame), Date.now());
  }

  pendingFrames<T>(runId: string): { identity: string; generation: number; frame: T }[] {
    return this.db.prepare(`SELECT identity,generation,frame FROM pending_engine_frames
      WHERE run_id=? AND associated=0 ORDER BY received_at,rowid`).all(runId).map((row) => ({
      identity: String(row.identity), generation: Number(row.generation), frame: JSON.parse(String(row.frame)) as T,
    }));
  }

  associatePendingFrame(identity: string): void {
    this.db.prepare("UPDATE pending_engine_frames SET associated=1 WHERE identity=?").run(identity);
  }

  eventsAfter(cursor: number, limit = 500): ProductEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE cursor>? ORDER BY cursor LIMIT ?")
      .all(cursor, limit).map((row) => ({
        cursor: Number(row.cursor), type: String(row.type), entityId: String(row.entity_id),
        data: JSON.parse(String(row.data)), createdAt: Number(row.created_at),
      }));
  }

  cursor(): number {
    return Number(this.db.prepare("SELECT coalesce(max(cursor),0) AS value FROM events").get()?.value ?? 0);
  }

  createBot(input: Pick<Bot, "name"> & Partial<Omit<Bot, "createdAt">>): Bot {
    if (!input.name.trim() || input.name.length > 80) throw new Error("A Bot name must contain 1–80 characters");
    const id = input.id ?? randomUUID();
    const spaceId = input.spaceId ?? DEFAULT_SPACE_ID;
    if (!this.listSpaces().some((space) => space.id === spaceId)) throw new Error("Unknown space");
    const agentId = input.agentId ?? `bot-${id.replaceAll("-", "")}`;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId)) throw new Error("Invalid agent identifier");
    if (this.db.prepare("SELECT id FROM records WHERE kind='bots' AND json_extract(data,'$.agentId')=? AND id != ?").get(agentId, id)) {
      throw new Error("This engine agent already belongs to another Bot");
    }
    const order = this.list<Bot>("bots")
      .filter((bot) => (bot.spaceId ?? DEFAULT_SPACE_ID) === spaceId)
      .map((bot) => bot.position ?? 0);
    return this.put("bots", {
      id, spaceId, agentId, name: input.name.trim(), description: input.description ?? "",
      identity: input.identity ?? "", color: input.color ?? "teal", createdAt: Date.now(),
      // Absent fields stay absent for records written before avatars and sections existed.
      ...(input.avatarSet !== undefined ? { avatarSet: input.avatarSet } : {}),
      pinned: input.pinned ?? false,
      position: input.position ?? (order.length ? Math.max(...order) + 1 : 0),
      ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
      ...(input.spawnKey !== undefined ? { spawnKey: input.spawnKey } : {}),
      notifyOnFinish: input.notifyOnFinish ?? true,
    });
  }

  /** Metadata a user can change from the panorama and the sidebar. */
  updateBot(id: string, patch: {
    name?: string; description?: string; identity?: string; color?: string;
    avatarSet?: string | null; pinned?: boolean; sectionId?: string | null;
    archivedAt?: number | null; notifyOnFinish?: boolean; autoSpeak?: boolean; voiceId?: string | null;
  }): Bot {
    const bot = this.get<Bot>("bots", id);
    if (!bot) throw new Error("Unknown Bot");
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 80)) {
      throw new Error("A Bot name must contain 1–80 characters");
    }
    if (patch.sectionId) {
      const section = this.get<BotSection>("botSections", patch.sectionId);
      if (!section || (section.spaceId ?? DEFAULT_SPACE_ID) !== this.spaceIdForBot(id)) throw new Error("Unknown Bot section");
    }
    const { avatarSet, sectionId, ...rest } = patch;
    return this.put("bots", {
      ...bot,
      ...(rest.name !== undefined ? { name: rest.name.trim() } : {}),
      ...(rest.description !== undefined ? { description: rest.description } : {}),
      ...(rest.voiceId !== undefined ? { voiceId: rest.voiceId ?? undefined } : {}),
      ...(rest.identity !== undefined ? { identity: rest.identity } : {}),
      ...(rest.color !== undefined ? { color: rest.color } : {}),
      ...(rest.pinned !== undefined ? { pinned: rest.pinned } : {}),
      ...(rest.notifyOnFinish !== undefined ? { notifyOnFinish: rest.notifyOnFinish } : {}),
      ...(rest.autoSpeak !== undefined ? { autoSpeak: rest.autoSpeak } : {}),
      ...(rest.archivedAt !== undefined ? { archivedAt: rest.archivedAt ?? undefined } : {}),
      // An explicit null clears the value; undefined leaves the record untouched.
      ...(avatarSet === null ? { avatarSet: undefined } : avatarSet === undefined ? {} : { avatarSet }),
      ...(sectionId === null ? { sectionId: undefined } : sectionId === undefined ? {} : { sectionId }),
    });
  }

  /** 1.0 destroyBot semantics: purge owned history, keep child Bots and unrelated members. */
  purgeBotData(botId: string): { records: number; events: number } {
    const bot = this.get<Bot>("bots", botId);
    if (!bot) return { records: 0, events: 0 };
    const rows = this.db.prepare("SELECT kind,id,data FROM records").all().map(row => ({
      kind: String(row.kind), id: String(row.id), data: JSON.parse(String(row.data)) as Record<string, any>,
    }));
    const chats = new Set(rows.filter(row => row.kind === "conversations" && row.data.kind === "private" && row.data.botIds?.includes(botId)).map(row => row.id));
    const tasks = new Set(rows.filter(row => row.kind === "tasks" && row.data.botId === botId).map(row => row.id));
    const runs = new Set(rows.filter(row => row.kind === "runs" && tasks.has(row.data.taskId)).map(row => row.id));
    const routines = new Set(rows.filter(row => row.kind === "routines" && row.data.botId === botId).map(row => row.id));
    const selected = rows.filter(row => row.kind === "bots" ? row.id === botId :
      row.kind === "conversations" ? chats.has(row.id) :
      row.data.botId === botId || tasks.has(row.data.taskId) || runs.has(row.data.runId) || routines.has(row.data.routineId) || chats.has(row.data.conversationId) ||
      (row.kind === "contextShares" && (chats.has(row.data.sourceConversationId) || chats.has(row.data.destinationConversationId))) ||
      (row.kind === "settings" && [ `bot-removal:${botId}`, `exclusive-capability-audit:${botId}` ].includes(row.id)));
    return this.transaction(() => {
      this.db.exec("PRAGMA secure_delete=ON");
      for (const chat of rows.filter(row => row.kind === "conversations" && row.data.kind === "group" && row.data.botIds?.includes(botId)))
        this.put("conversations", { ...chat.data, id: chat.id, botIds: chat.data.botIds.filter((id: string) => id !== botId) });
      let events = 0;
      for (const row of selected) {
        this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(row.kind, row.id);
        events += Number(this.db.prepare("DELETE FROM events WHERE entity_id=?").run(row.id).changes);
      }
      for (const id of runs) this.db.prepare("DELETE FROM pending_engine_frames WHERE run_id=?").run(id);
      this.recordEvent("bots.removed", botId, { id: botId });
      return { records: selected.length, events };
    });
  }

  /** Applies one explicit order; positions follow the array, unknown ids are rejected. */
  reorderBots(ids: string[], spaceId?: string): Bot[] {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) throw new Error("An order cannot repeat a Bot");
    const known = new Set(this.list<Bot>("bots")
      .filter((bot) => spaceId === undefined || (bot.spaceId ?? DEFAULT_SPACE_ID) === spaceId)
      .map((bot) => bot.id));
    for (const id of unique) if (!known.has(id)) throw new Error("Unknown Bot in order");
    return this.transaction(() => unique.map((id, position) =>
      this.put("bots", { ...this.get<Bot>("bots", id)!, position })));
  }

  createBotSection(name: string): BotSection {
    return this.createSpaceBotSection(DEFAULT_SPACE_ID, name);
  }

  createSpaceBotSection(spaceId: string, name: string): BotSection {
    if (!this.listSpaces().some((space) => space.id === spaceId)) throw new Error("Unknown space");
    if (!name.trim() || name.length > 40) throw new Error("A section name must contain 1–40 characters");
    const existing = this.list<BotSection>("botSections")
      .filter((section) => (section.spaceId ?? DEFAULT_SPACE_ID) === spaceId);
    if (existing.some((section) => section.name === name.trim())) throw new Error("This section already exists");
    return this.put("botSections", {
      id: randomUUID(), name: name.trim(), position: existing.length ? Math.max(...existing.map((s) => s.position)) + 1 : 0,
      createdAt: Date.now(), spaceId,
    });
  }

  updateBotSection(id: string, patch: { name?: string; position?: number }): BotSection {
    const section = this.get<BotSection>("botSections", id);
    if (!section) throw new Error("Unknown Bot section");
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 40)) {
      throw new Error("A section name must contain 1–40 characters");
    }
    return this.put("botSections", {
      ...section,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    });
  }

  /** Deleting a section never deletes Bots; they return to the unsectioned list. */
  deleteBotSection(id: string): void {
    const section = this.get<BotSection>("botSections", id);
    if (!section) throw new Error("Unknown Bot section");
    this.transaction(() => {
      for (const bot of this.list<Bot>("bots").filter((entry) => entry.sectionId === id)) {
        this.put("bots", { ...bot, sectionId: undefined });
      }
      for (const group of this.list<Conversation>("conversations").filter((entry) => entry.sectionId === id)) {
        this.put("conversations", { ...group, sectionId: undefined });
      }
      // The section record itself is archived rather than dropped, so a mistaken
      // removal can be undone from the journal.
      this.put("botSections", { ...section, name: `${section.name}（已移除）`, position: -1 });
    });
  }

  /**
   * `id` is an idempotency key when the caller supplies one: a retried creation with
   * the same key reuses the existing conversation instead of opening another session.
   */
  createConversation(kind: Conversation["kind"], botIds: string[], title: string, id?: string): Conversation {
    if (kind !== "private" && kind !== "group") throw new Error("Invalid conversation kind");
    const unique = [...new Set(botIds)];
    if (unique.length === 0 || (kind === "private" && unique.length !== 1)) throw new Error("Invalid conversation members");
    const spaces = new Set(unique.map((botId) => this.spaceIdForBot(botId)));
    if (spaces.size !== 1) throw new Error("Conversation members must belong to one space");
    const spaceId = [...spaces][0]!;
    if (id) {
      const existing = this.get<Conversation>("conversations", id);
      if (existing) {
        if (existing.kind !== kind || JSON.stringify(existing.botIds) !== JSON.stringify(unique)) {
          throw new Error("Conversation identity conflicts with existing members");
        }
        return existing;
      }
    }
    return this.put("conversations", {
      ...(id ? { id } : { id: randomUUID() }),
      spaceId,
      kind, botIds: unique, title: title.slice(0, 160), createdAt: Date.now(),
    });
  }

  privateConversation(botId: string): Conversation {
    const privateOnes = this.list<Conversation>("conversations", -1)
      .filter((conversation) => conversation.kind === "private" && conversation.botIds[0] === botId);
    // The home thread is marked; older records without the mark adopt their oldest
    // private conversation. Picking by id alone would hand back a task session,
    // because two conversations created in the same millisecond sort by id.
    const marked = privateOnes.find((conversation) => conversation.main === true);
    if (marked) return marked;
    const existing = privateOnes[0];
    if (existing) return this.put("conversations", { ...existing, main: true }, "conversations.main");
    const bot = this.get<Bot>("bots", botId);
    if (!bot) throw new Error("Unknown Bot");
    const created = this.createConversation("private", [botId], bot.name);
    return this.put("conversations", { ...created, main: true }, "conversations.main");
  }

  engineSessionKey(conversationId: string, botId: string): string {
    const conversation = this.get<Conversation>("conversations", conversationId);
    const bot = this.get<Bot>("bots", botId);
    if (!conversation?.botIds.includes(botId) || !bot) throw new Error("Bot is not a conversation member");
    if (bot.archivedAt !== undefined) throw new Error("请先恢复已归档的 Bot");
    return conversation.kind === "group"
      ? `agent:${bot.agentId}:livingbot:group:${conversation.id}`
      : `agent:${bot.agentId}:explicit:livingbot-${conversation.id}`;
  }

  messages(conversationId: string): Message[] {
    return deliveredMessages(this.find<Message>("messages", "conversationId", conversationId), this.list<Artifact>("artifacts", -1)).filter((message) =>
      message.role !== "assistant" || message.final || hasReplyContent(message.blocks) ||
      !this.get<Task>("tasks", message.taskId ?? "")?.routine);
  }

  /** Messages still in view: a cleared conversation starts empty without losing history. */
  visibleMessages(conversationId: string): Message[] {
    const clearedAt = this.get<Conversation>("conversations", conversationId)?.clearedAt;
    const history = this.messages(conversationId);
    return clearedAt === undefined ? history : history.filter((message) => message.createdAt > clearedAt);
  }

  /** Hide the current transcript from view; the rows stay for a later recovery. */
  clearConversation(conversationId: string): Conversation {
    const conversation = this.get<Conversation>("conversations", conversationId);
    if (!conversation) throw new Error("Unknown conversation");
    return this.put("conversations", { ...conversation, clearedAt: Date.now() }, "conversations.cleared");
  }

  attachment(id: string, botId: string, conversationId: string): Artifact {
    this.engineSessionKey(conversationId, botId);
    const conversation = this.get<Conversation>("conversations", conversationId)!;
    const file = this.get<Artifact>("artifacts", id);
    if (!file || file.origin !== "attachment" || file.conversationId !== conversationId ||
      (file.botId !== botId && (conversation.kind !== "group" || !conversation.botIds.includes(file.botId)))) {
      throw new Error("File does not belong to this Bot conversation");
    }
    return file;
  }

  beginGroup(input: GroupInput): { task: Task; submission: SubmissionRecord }[] {
    return this.transaction(() => {
      const conversation = this.get<Conversation>("conversations", input.conversationId);
      if (conversation?.kind !== "group" || conversation.archivedAt !== undefined || !input.botIds.length || input.botIds.length > 32 ||
        new Set(input.botIds).size !== input.botIds.length ||
        input.botIds.some((id) => !conversation.botIds.includes(id))) throw new Error("Invalid group recipients");
      const normalized = {
        id: `group-input:${input.submissionId}`, conversationId: input.conversationId,
        botIds: [...input.botIds].sort(), message: input.message, attachmentIds: input.attachmentIds ?? [],
        ...(input.queueMode === "steer" ? { queueMode: input.queueMode } : {}),
      };
      const previous = this.get<typeof normalized>("settings", normalized.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) throw new Error("Group input identity conflicts with existing content");
      if (!previous) this.put("settings", normalized, "group-input.recorded");
      return normalized.botIds.map((botId) => this.beginSubmission({
        submissionId: `group:${createHash("sha256").update(JSON.stringify([input.submissionId, botId])).digest("hex")}`,
        conversationId: input.conversationId, botId, message: input.message,
        attachmentIds: input.attachmentIds, groupSubmissionId: input.submissionId,
        queueMode: input.queueMode,
      }));
    });
  }

  beginSubmission(input: {
    submissionId: string;
    conversationId: string;
    botId: string;
    message: string;
    hiddenInput?: boolean;
    voicePlayback?: SubmissionRecord["voicePlayback"];
    reportConversationId?: string;
    parentTaskId?: string;
    fileBatchId?: string;
    attachmentIds?: string[];
    groupSubmissionId?: string;
    originBotId?: string;
    queueMode?: "followup" | "steer";
  }): { task: Task; submission: SubmissionRecord; duplicate: boolean } {
    if ((!input.message.trim() && !input.attachmentIds?.length) || input.message.length > 500_000) throw new Error("Invalid message length");
    if (input.queueMode !== undefined && input.queueMode !== "followup" && input.queueMode !== "steer") {
      throw new Error("Invalid input mode");
    }
    return this.transaction(() => {
      const existing = this.get<SubmissionRecord>("submissions", input.submissionId);
      const sessionKey = this.engineSessionKey(input.conversationId, input.botId);
      if (input.voicePlayback) {
        const reference = this.get<Message>("messages", input.voicePlayback.messageId);
        if (typeof input.voicePlayback.heardText !== "string" || input.voicePlayback.heardText.length > 8000 ||
          reference?.role !== "assistant" || reference.conversationId !== input.conversationId)
          throw new Error("Invalid voice playback receipt");
      }
      if (existing) {
        if (JSON.stringify(existing.voicePlayback) !== JSON.stringify(input.voicePlayback)) throw new Error("Submission voice playback conflicts");
        if (Boolean(existing.hiddenInput) !== Boolean(input.hiddenInput)) throw new Error("Submission input visibility conflicts");
        if (existing.sessionKey !== sessionKey || existing.message !== input.message) throw new Error("Submission identity conflicts with existing content");
        if ((existing.queueMode ?? "followup") !== (input.queueMode ?? "followup")) throw new Error("Submission identity conflicts with existing input mode");
        if (JSON.stringify(existing.attachmentIds ?? []) !== JSON.stringify(input.attachmentIds ?? [])) {
          throw new Error("Submission identity conflicts with existing files");
        }
        const task = this.get<Task>("tasks", existing.taskId);
        if (!task) throw new Error("Missing submission task");
        if ((existing.initialReportConversationId ?? task.reportConversationId) !== (input.reportConversationId ?? input.conversationId) ||
          existing.groupSubmissionId !== input.groupSubmissionId ||
          existing.originBotId !== input.originBotId ||
          task.parentTaskId !== input.parentTaskId ||
          task.fileBatchId !== input.fileBatchId) throw new Error("Submission identity conflicts with existing routing");
        return { task, submission: existing, duplicate: true };
      }
      const reportConversationId = input.reportConversationId ?? input.conversationId;
      const reportConversation = this.get<Conversation>("conversations", reportConversationId);
      if (!reportConversation?.botIds.includes(input.botId)) throw new Error("Invalid report destination");
      if (input.originBotId) {
        const parent = input.parentTaskId ? this.get<Task>("tasks", input.parentTaskId) : undefined;
        if (!parent || parent.botId !== input.originBotId || parent.conversationId !== input.conversationId ||
          this.get<Conversation>("conversations", input.conversationId)?.kind !== "group") {
          throw new Error("Invalid assignment origin");
        }
        this.engineSessionKey(input.conversationId, input.originBotId);
      }
      const now = Date.now();
      const task: Task = {
        id: randomUUID(), botId: input.botId, conversationId: input.conversationId,
        reportConversationId, title: input.hiddenInput ? (input.submissionId.startsWith("call-wrapup:") ? "通话收尾" : input.submissionId.startsWith("admin-delegation:") ? "管理员分派" : "开场引导") : input.message.slice(0, 100), status: "queued",
        createdAt: now, updatedAt: now,
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.fileBatchId ? { fileBatchId: input.fileBatchId } : {}),
      };
      const submission: SubmissionRecord = {
        id: input.submissionId, taskId: task.id, sessionKey, message: input.message,
        state: "pending", createdAt: now, initialReportConversationId: reportConversationId,
        ...(input.hiddenInput ? { hiddenInput: true } : {}),
        ...(input.voicePlayback ? { voicePlayback: input.voicePlayback } : {}),
        ...(input.queueMode ? { queueMode: input.queueMode } : {}),
        ...(input.groupSubmissionId ? { groupSubmissionId: input.groupSubmissionId } : {}),
        ...(input.originBotId ? { originBotId: input.originBotId } : {}),
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
      };
      this.put("tasks", task);
      this.put("submissions", submission);
      const messageId = input.groupSubmissionId ? `group-input:${input.groupSubmissionId}` : `input:${input.submissionId}`;
      if (!input.hiddenInput && !this.get("messages", messageId)) this.put<Message>("messages", {
        id: messageId, conversationId: input.conversationId,
        role: input.originBotId ? "assistant" : "user",
        ...(input.originBotId ? { botId: input.originBotId } : {}),
        ...(!input.groupSubmissionId ? { taskId: task.id } : {}), blocks: [
          ...(input.message ? [{ id: "text", kind: "text" as const, text: input.message,
            ...(input.voicePlayback ? { voicePlayback: input.voicePlayback } : {}) }] : []),
          ...(input.attachmentIds ?? []).map((id) => {
            const file = this.attachment(id, input.botId, input.conversationId);
            return { id, kind: "file" as const, artifactId: id, name: file.name, mediaType: file.mediaType };
          }),
        ],
        ...(input.submissionId.startsWith("call:") ? { clientNonce: input.submissionId } : {}),
        final: true, createdAt: now, updatedAt: now,
      });
      return { task, submission, duplicate: false };
    });
  }

  beginContinuation(taskId: string, submissionId: string, sessionId: string, expectedLeafEntryId: string | null): SubmissionRecord {
    return this.transaction(() => {
      const existing = this.get<SubmissionRecord>("submissions", submissionId);
      if (existing) {
        if (existing.taskId !== taskId || !existing.continuationOf) throw new Error("Continuation identity conflicts with existing work");
        return existing;
      }
      const task = this.get<Task>("tasks", taskId);
      if (!task || !["interrupted", "failed"].includes(task.status) || task.stopRequestedAt !== undefined || task.delegation) {
        throw new Error("This task cannot be continued");
      }
      for (let ancestor = task.parentTaskId ? this.get<Task>("tasks", task.parentTaskId) : undefined;
        ancestor; ancestor = ancestor.parentTaskId ? this.get<Task>("tasks", ancestor.parentTaskId) : undefined) {
        if (ancestor.stopRequestedAt !== undefined) throw new Error("The parent task was stopped");
      }
      const source = this.find<SubmissionRecord>("submissions", "taskId", taskId).find((input) => !input.continuationOf);
      if (!source || !sessionId) throw new Error("Missing original task or native session");
      const sessionKey = this.engineSessionKey(task.conversationId, task.botId);
      if (source.sessionKey !== sessionKey) throw new Error("The task session changed");
      this.engineSessionKey(task.reportConversationId, task.botId);
      const now = Date.now();
      const submission: SubmissionRecord = {
        id: submissionId, taskId, sessionKey, sessionId, expectedLeafEntryId,
        continuationOf: source.id, message: task.fileBatchId
          ? `继续这项工作。\n\n原始任务：\n${source.message}` : "继续这项工作。",
        attachmentIds: source.attachmentIds, state: "pending", createdAt: now,
        initialReportConversationId: task.reportConversationId, queueMode: "followup",
      };
      this.put("submissions", submission);
      this.put("tasks", { ...task, status: "queued", error: undefined, continuationSubmissionId: submissionId, updatedAt: now });
      this.put<Message>("messages", {
        id: `input:${submissionId}`, conversationId: task.conversationId, taskId,
        role: "user", blocks: [{ id: "text", kind: "text", text: submission.message }],
        final: true, createdAt: now, updatedAt: now,
      });
      return submission;
    });
  }

  acceptSubmission(id: string, runId: string, generation = 0): void {
    this.transaction(() => {
      const submission = this.get<SubmissionRecord>("submissions", id);
      if (!submission) throw new Error("Unknown submission");
      if (submission.engineRunId && submission.engineRunId !== runId) throw new Error("Engine receipt changed run identity");
      const existingRun = this.get<Run>("runs", runId);
      if (existingRun && (existingRun.taskId !== submission.taskId || existingRun.sessionKey !== submission.sessionKey)) {
        throw new Error("Engine receipt conflicts with an existing run owner");
      }
      this.put("submissions", { ...submission, state: "accepted", engineRunId: runId });
      this.ensureRun(runId, submission.sessionKey, generation, submission.taskId);
      const task = this.get<Task>("tasks", submission.taskId);
      if (task?.fileBatchId) {
        const batch = this.get<FileBatch>("fileBatches", task.fileBatchId);
        const item = batch?.items.find((entry) => entry.taskId === task.id);
        if (batch && item && !item.accepted) this.put<FileBatch>("fileBatches", {
          ...batch, items: batch.items.map((entry) => entry.taskId === task.id ? { ...entry, accepted: true } : entry),
        }, "fileBatches.changed");
      }
      if (task?.continuationSubmissionId === id) {
        this.put("tasks", { ...task, continuationSubmissionId: undefined, updatedAt: Date.now() });
      }
    });
  }

  ensureRun(runId: string, sessionKey: string, generation: number, explicitTaskId?: string): Run | undefined {
    const existing = this.get<Run>("runs", runId);
    if (existing) return existing;
    const submissions = this.find<SubmissionRecord>("submissions", "sessionKey", sessionKey);
    const matching = submissions.find((submission) => submission.engineRunId === runId || submission.id === runId);
    const interrupted = [...new Set([
      ...submissions.map((submission) => submission.taskId),
      ...this.find<Run>("runs", "sessionKey", sessionKey).map((run) => run.taskId),
    ])]
      .map((taskId) => this.get<Task>("tasks", taskId))
      // Scheduled invocations are rebound only by their host job/run identity.
      // A later recurrence in the same session cannot resume the old task.
      .filter((task): task is Task => task?.status === "interrupted" && !task.routine);
    // Native restart continuation has a new run ID. Only associate it when
    // exactly one interrupted task owns the same physical/logical session.
    // Choosing the most recently queued task silently misroutes older work.
    const taskId = explicitTaskId ?? matching?.taskId ?? (interrupted.length === 1 ? interrupted[0]!.id : undefined);
    if (!taskId) return undefined;
    const run: Run = { id: runId, taskId, sessionKey, generation, state: "queued", lastSequence: -1, createdAt: Date.now(),
      ...(matching?.id.startsWith("call:") ? { clientNonce: matching.id } : {}) };
    return this.put("runs", run);
  }

  updateTask(id: string, status: TaskStatus, error?: string): void {
    const task = this.get<Task>("tasks", id);
    if (!task || (terminal.has(task.status) && task.status !== status)) return;
    this.put("tasks", {
      ...task, status: task.stopRequestedAt !== undefined && ["queued", "running", "waiting"].includes(status) ? "stopping" : status,
      updatedAt: Date.now(), ...(error ? { error } : {}),
    });
  }

  notifyResult(taskId: string, runId: string, messageId: string): ResultNotification | undefined {
    return this.transaction(() => {
      const id = `result:${runId}`;
      const existing = this.get<ResultNotification>("notifications", id);
      if (existing) return existing;
      const task = this.get<Task>("tasks", taskId);
      const run = this.get<Run>("runs", runId);
      const message = this.get<Message>("messages", messageId);
      if (!task || !run || run.taskId !== task.id || !message?.final || !hasReplyContent(message.blocks, message.silent) || message.role !== "assistant" ||
        message.taskId !== task.id || message.runId !== run.id || message.botId !== task.botId ||
        message.conversationId !== task.reportConversationId || task.inputDisposition === "steered" ||
        !["completed", "failed"].includes(run.state)) return undefined;
      if (task.routine && this.get<{ runId: string }>("settings", `automation-result:${task.routine.occurrenceId}`)?.runId !== runId) return undefined;
      return this.put<ResultNotification>("notifications", {
        id, taskId: task.id, runId, botId: task.botId, conversationId: message.conversationId,
        messageId, outcome: run.state as ResultNotification["outcome"], createdAt: Date.now(),
      });
    });
  }

  readNotification(id: string): ResultNotification {
    return this.transaction(() => {
      const notification = this.get<ResultNotification>("notifications", id);
      if (!notification) throw new Error("Unknown notification");
      return notification.readAt !== undefined ? notification : this.put("notifications", { ...notification, readAt: Date.now() });
    });
  }

  listScratchpad(botId: string, includeDone = false): ScratchpadItem[] {
    if (!this.get<Bot>("bots", botId)) throw new Error("Unknown Bot");
    return this.list<ScratchpadItem>("scratchpad", -1)
      .filter((item) => item.botId === botId && !item.removedAt && (includeDone || item.status !== "done"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  }

  saveScratchpad(item: ScratchpadItem): ScratchpadItem {
    if (!this.get<Bot>("bots", item.botId)) throw new Error("Unknown Bot");
    return this.put("scratchpad", item);
  }

  updateScratchpad(botId: string, id: string, changes: Partial<Pick<ScratchpadItem, "title" | "status" | "notes">>): ScratchpadItem {
    const current = this.get<ScratchpadItem>("scratchpad", id);
    if (!current || current.botId !== botId || current.removedAt) throw new Error("To-do not found");
    return this.saveScratchpad({ ...current, ...changes, updatedAt: new Date().toISOString() });
  }

  removeScratchpad(botId: string, id: string): void {
    const current = this.get<ScratchpadItem>("scratchpad", id);
    if (!current || current.botId !== botId || current.removedAt) throw new Error("To-do not found");
    this.saveScratchpad({ ...current, removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  snapshot(): Snapshot {
    const latest = this.latestPerConversation();
    const lastMessageSeq: Record<string, number> = {};
    const lastMessages: Record<string, LastMessagePreview> = {};
    for (const [conversationId, row] of Object.entries(latest)) {
      lastMessageSeq[conversationId] = row.seq;
      if (row.message) {
        lastMessages[conversationId] = {
          role: row.message.role,
          text: messagePreviewText(row.message),
          createdAt: row.message.createdAt,
        };
      }
    }
    return {
      bots: this.list<Bot>("bots"), conversations: this.list<Conversation>("conversations"),
      tasks: this.list<Task>("tasks"), abilities: this.list<Ability>("abilities"), cursor: this.cursor(),
      interactions: this.list<Interaction>("interactions"),
      notifications: this.list<ResultNotification>("notifications"),
      fileBatches: this.list<FileBatch>("fileBatches"),
      // Read boundaries and emoji replies are product rows the sidebar and transcript
      // render; the snapshot carries them so a refresh shows the same state.
      readState: this.list<ReadState>("readState"),
      reactions: this.list<StoredReaction>("reactions"),
      lastMessageSeq,
      lastMessages,
    };
  }

  /** The newest visible message of each conversation, read once for the sidebar's rows. */
  private latestPerConversation(): Record<string, { seq: number; message?: Message }> {
    const latest: Record<string, { seq: number; message?: Message }> = {};
    for (const conversation of this.list<Conversation>("conversations", -1)) {
      const visible = this.visibleMessages(conversation.id);
      latest[conversation.id] = {
        seq: visible.length - 1,
        // Empty lifecycle/tool records must not erase the last readable message.
        message: visible.findLast((message) => Boolean(messagePreviewText(message))),
      };
    }
    return latest;
  }

  /** The seq of each conversation's newest visible message: -1 when it has none. */
  lastMessageSeqs(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [conversationId, row] of Object.entries(this.latestPerConversation())) {
      counts[conversationId] = row.seq;
    }
    return counts;
  }

  /** The read boundary of one conversation, defaulting to "nothing read yet". */
  readState(conversationId: string): ReadState {
    return this.get<ReadState>("readState", `read:${conversationId}`)
      ?? { id: `read:${conversationId}`, conversationId, lastReadSeq: -1, unread: false };
  }

  /** Latest message seq in a conversation; -1 when it has none. */
  lastMessageSeq(conversationId: string): number {
    return this.visibleMessages(conversationId).length - 1;
  }

  /** Mark every message up to the current boundary read and report the old boundary. */
  markRead(conversationId: string): { unreadAfterSeq: number | null } {
    return this.transaction(() => {
      const current = this.readState(conversationId);
      const latest = this.lastMessageSeq(conversationId);
      if (!current.unread && current.lastReadSeq >= latest) return { unreadAfterSeq: null };
      const unreadAfterSeq =
        current.unread && current.lastReadSeq < latest ? current.lastReadSeq : null;
      this.put("readState", { ...current, lastReadSeq: latest, unread: false, updatedAt: Date.now() });
      return { unreadAfterSeq };
    });
  }

  /** Mark unread from a message (boundary moves to just before it) or from the end. */
  markUnread(conversationId: string, messageId?: string): void {
    this.transaction(() => {
      const current = this.readState(conversationId);
      if (!messageId) {
        this.put("readState", { ...current, unread: true, updatedAt: Date.now() });
        return;
      }
      const history = this.messages(conversationId);
      const index = history.findIndex((message) => message.id === messageId);
      if (index < 0) throw new Error("Message does not belong to this conversation");
      this.put("readState", {
        ...current, lastReadSeq: index - 1, unread: true, updatedAt: Date.now(),
      });
    });
  }

  setUnreadState(conversationId: string, unread: boolean): void {
    this.transaction(() => {
      const current = this.readState(conversationId);
      if (current.unread === unread) return;
      this.put("readState", { ...current, unread, updatedAt: Date.now() });
    });
  }


  engineIdentity(generation: number, event: string, payload: Record<string, unknown>): string {
    const stable = JSON.stringify([generation, event, payload.runId, payload.seq, payload]);
    return createHash("sha256").update(stable).digest("hex");
  }

  artifact(id: string): Artifact | undefined {
    return this.get<Artifact>("artifacts", id);
  }
}
