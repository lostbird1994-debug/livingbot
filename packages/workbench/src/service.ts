import { nativeMessageBlocks, mergeNativeMessage } from "./native-message-blocks.ts";
import { createHash } from "node:crypto";
import type { Acceptance, GatewayRequests, HistoryPage, RuntimeObservation, Submission } from "../../kernel-runtime/src/contracts.ts";
import { fileLimits } from "./contracts.ts";
import type { Bot, Conversation, FileBatch, FileBatchInput, FileBatchReceipt, GroupAssignment, GroupInput, GroupReceipt, Message, Run, SubmissionRecord, Task } from "./contracts.ts";
import { nativeTask } from "./authority.ts";
import type { NativeAuthority } from "./authority.ts";
import { EngineProjector } from "./projector.ts";
import { WorkbenchStore } from "./store.ts";
import { Interactions } from "./interactions.ts";
import { Abilities } from "./abilities.ts";
import { ConversationContext } from "./context.ts";
import type { Files } from "./files.ts";
import { Memories } from "./memory.ts";
import type { MemoryProvider } from "../../kernel-runtime/src/memory.ts";
import type { CapabilityProvider } from "../../kernel-runtime/src/capabilities.ts";
import { Processes } from "./processes.ts";
import { isSilentReply } from "./reply-content.ts";
import { Routines } from "./routines.ts";
import type { NativeScheduledRun } from "./routines.ts";
import type { RoutineProvider } from "../../kernel-runtime/src/routines.ts";
import { nativeWidgets } from "./widgets.ts";

export interface KernelControl extends GatewayRequests {
  readonly maintenance?: boolean;
  generation: number;
  phase: string;
  on(event: "observation", listener: (observation: RuntimeObservation) => void): unknown;
  off(event: "observation", listener: (observation: RuntimeObservation) => void): unknown;
  send(submission: Submission): Promise<Acceptance>;
  recoverHistory(sessionKey: string, cursor?: string, inputRunIds?: string[]): Promise<HistoryPage>;
  abort(sessionKey: string, runId?: string): Promise<unknown>;
}

type SubmissionInput = {
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
};

type HistoryCheckpoint = { id: string; cursor?: string; sessionId?: string };

/** Product orchestration; OpenClaw alone dispatches model turns and tools. */
export class WorkbenchService {
  readonly store: WorkbenchStore;
  readonly kernel: KernelControl;
  readonly interactions: Interactions;
  readonly abilities?: Abilities;
  readonly context: ConversationContext;
  readonly files?: Files;
  readonly memories?: Memories;
  readonly processes: Processes;
  readonly routines?: Routines;
  private readonly projector: EngineProjector;
  private readonly dispatching = new Map<string, Promise<Task>>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly advancingFileBatches = new Map<string, Promise<void>>();
  private detached = false;
  private readonly observer: (observation: RuntimeObservation) => void;

  constructor(store: WorkbenchStore, kernel: KernelControl, capabilityProvider?: CapabilityProvider, files?: Files, memoryProvider?: MemoryProvider, routineProvider?: RoutineProvider) {
    this.store = store;
    this.kernel = kernel;
    this.projector = new EngineProjector(store);
    this.interactions = new Interactions(store, kernel);
    this.processes = new Processes(store, kernel);
    this.context = new ConversationContext(store);
    this.files = files;
    if (routineProvider) this.routines = new Routines(store, routineProvider);
    if (memoryProvider) this.memories = new Memories(store, memoryProvider);
    if (capabilityProvider) this.abilities = new Abilities(store, capabilityProvider);
    this.observer = (observation) => {
      if (observation.type === "phase" && observation.phase === "starting") {
        this.store.put("settings", { id: "kernel-generation", generation: observation.generation }, "kernel.generation");
      }
      this.projector.observe(observation);
      if (observation.type === "frame" && observation.frame.event === "chat" &&
        ["final", "error", "aborted"].includes(String(observation.frame.payload?.state))) {
        const runId = observation.frame.payload?.runId;
        const run = typeof runId === "string" ? this.store.get<Run>("runs", runId) : undefined;
        const task = run && this.store.get<Task>("tasks", run.taskId);
        if (task?.fileBatchId) void this.advanceFileBatch(task.fileBatchId)
          .catch((error: unknown) => this.diagnostic("file-batch-advance", error, task.fileBatchId));
      }
      this.interactions.observe(observation);
      this.processes.observe(observation);
      this.routines?.observe(observation);
      if (observation.type === "frame" && observation.frame.event === "agent" &&
        observation.frame.payload?.stream === "lifecycle" && asObject(observation.frame.payload.data).phase === "start") {
        const runId = observation.frame.payload.runId;
        const run = typeof runId === "string" ? this.store.get<Run>("runs", runId) : undefined;
        const task = run && this.store.get<Task>("tasks", run.taskId);
        if (task?.stopRequestedAt !== undefined) {
          void this.cancelOne(task.id).catch((error: unknown) => this.diagnostic("cancellation", error, task.id));
        }
      }
      if (observation.type === "frame" && observation.frame.event === "agent" &&
        observation.frame.payload?.stream === "tool" &&
        asObject(observation.frame.payload.data).name === "sessions_spawn" &&
        asObject(observation.frame.payload.data).phase === "result") {
        const runId = observation.frame.payload.runId;
        const run = typeof runId === "string" ? this.store.get<Run>("runs", runId) : undefined;
        const parent = run && this.store.get<Task>("tasks", run.taskId);
        if (parent?.stopRequestedAt !== undefined) {
          void this.cancel(parent.id).catch((error: unknown) => this.diagnostic("cancellation", error, parent.id));
        }
      }
      if (observation.type === "frame" && observation.frame.event === "session.message") {
        const payload = observation.frame.payload;
        if (typeof payload?.sessionKey === "string") {
          this.store.transaction(() => this.restoreMessage(payload.sessionKey as string, payload, false));
        }
      }
      if (observation.type === "ready" || observation.type === "gap") {
        // Recovery is triggered by a connection fact, never by a polling clock.
        void this.reconcile().catch((error: unknown) => this.diagnostic("recovery", error));
        if (this.routines?.list().length) void this.routines.reconcile().then(() => this.reconcile())
          .catch((error: unknown) => this.diagnostic("schedules", error));
      }
    };
    kernel.on("observation", this.observer);
  }

  detach(): void {
    this.routines?.detach();
    this.processes.detach();
    this.detached = true;
    this.kernel.off("observation", this.observer);
  }

  private diagnostic(stage: string, error: unknown, entityId = "kernel"): void {
    if (!this.detached) this.store.recordEvent("operation.failed", entityId, {
      stage, message: error instanceof Error ? error.message : String(error),
    });
  }

  async submit(input: SubmissionInput): Promise<Task> {
    if (this.kernel.maintenance) throw new Error("Kernel memory maintenance is in progress");
    if (input.attachmentIds?.length) {
      if (!this.files) throw new Error("File storage is unavailable");
      this.files.validateAttachments(input.attachmentIds, input.botId, input.conversationId);
    }
    const started = this.store.beginSubmission({ ...input,
      queueMode: input.queueMode ?? (input.hiddenInput || input.originBotId ? "followup" : "steer"),
    });
    return this.sendSubmission(started.submission);
  }

  async adoptScheduledRun(input: NativeScheduledRun): Promise<Task | undefined> {
    if (!this.routines) return undefined;
    const generation = this.kernel.generation;
    const task = await this.routines.adoptRun(input, generation, () => {
      if (this.detached || generation !== this.kernel.generation) throw new Error("Scheduled run belongs to a previous kernel");
    });
    if (this.detached || generation !== this.kernel.generation) throw new Error("Scheduled run belongs to a previous kernel");
    if (task) {
      this.interactions.replayPending(input.runId);
      this.projector.replayPending(input.runId);
    }
    return task;
  }

  private async sendSubmission(submission: SubmissionRecord): Promise<Task> {
    if (submission.state === "accepted" || submission.state === "rejected") return this.task(submission.taskId);
    const existing = this.dispatching.get(submission.id);
    if (existing) return existing;
    const dispatch = this.dispatch(submission)
      .finally(() => this.dispatching.delete(submission.id));
    this.dispatching.set(submission.id, dispatch);
    return dispatch;
  }

  async continueTask(taskId: string, submissionId: string): Promise<Task> {
    if (this.kernel.maintenance) throw new Error("Kernel memory maintenance is in progress");
    const existing = this.store.get<SubmissionRecord>("submissions", submissionId);
    if (existing) {
      if (existing.taskId !== taskId || !existing.continuationOf) throw new Error("Continuation identity conflicts with existing work");
      return this.sendSubmission(existing);
    }
    const task = this.task(taskId);
    if (!["interrupted", "failed"].includes(task.status) || task.stopRequestedAt !== undefined || task.delegation) throw new Error("This task cannot be continued");
    const sessionKey = this.store.engineSessionKey(task.conversationId, task.botId);
    const history = await this.kernel.recoverHistory(sessionKey);
    const session = history.sessionInfo;
    if (session?.key !== sessionKey || session.hasActiveRun !== false || !session.sessionId ||
      (typeof session.activeLeafEntryId !== "string" && session.activeLeafEntryId !== null)) {
      throw new Error("Native task state is not ready for continuation");
    }
    return this.sendSubmission(this.store.beginContinuation(taskId, submissionId, session.sessionId, session.activeLeafEntryId));
  }

  async submitGroup(input: GroupInput): Promise<GroupReceipt> {
    if (this.kernel.maintenance) throw new Error("Kernel memory maintenance is in progress");
    if (input.attachmentIds?.length) {
      if (!this.files) throw new Error("File storage is unavailable");
      for (const botId of input.botIds) this.files.validateAttachments(input.attachmentIds, botId, input.conversationId);
    }
    // Persist every recipient and the one visible input before any network work.
    return this.submitBatch(this.store.beginGroup({ ...input, queueMode: input.queueMode ?? "steer" }));
  }

  async submitFileBatch(input: FileBatchInput): Promise<FileBatchReceipt> {
    if (this.kernel.maintenance) throw new Error("Kernel memory maintenance is in progress");
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.id) || !input.instruction.trim() || input.instruction.length > 100_000 ||
      !input.attachmentIds.length || input.attachmentIds.length > fileLimits.attachments ||
      new Set(input.attachmentIds).size !== input.attachmentIds.length) throw new Error("Invalid file batch");
    if (!this.files) throw new Error("File storage is unavailable");
    this.files.validateAttachments(input.attachmentIds, input.botId, input.conversationId);
    const { batch, started } = this.store.transaction(() => {
      const previous = this.store.get<FileBatch>("fileBatches", input.id);
      if (previous && (previous.botId !== input.botId || previous.conversationId !== input.conversationId ||
        previous.instruction !== input.instruction || JSON.stringify(previous.attachmentIds) !== JSON.stringify(input.attachmentIds))) {
        throw new Error("Batch identity conflicts with existing content");
      }
      const started = input.attachmentIds.map((attachmentId) => {
        const file = this.store.artifact(attachmentId)!;
        const submissionId = `file-batch:${createHash("sha256").update(JSON.stringify([input.id, attachmentId])).digest("hex")}`;
        return {
          name: file.name, attachmentId,
          ...this.store.beginSubmission({
            submissionId, botId: input.botId, conversationId: input.conversationId, fileBatchId: input.id,
            message: `${input.instruction}\n\n本项文件：${file.name}\n逐项处理：本次只处理这一个附件，保留原文件，单独交付本项结果。`,
            attachmentIds: [attachmentId],
          }),
        };
      });
      const batch = previous ?? this.store.put<FileBatch>("fileBatches", {
        ...input, createdAt: Date.now(),
        items: started.map(({ name, attachmentId, task, submission }) => ({ name, attachmentId, taskId: task.id, submissionId: submission.id })),
      });
      return { batch, started };
    });
    await this.advanceFileBatch(batch.id);
    const current = this.store.get<FileBatch>("fileBatches", batch.id)!;
    return { batch: current, outcomes: this.fileBatchOutcomes(current).outcomes };
  }

  async retryFileBatch(id: string, retryId: string): Promise<FileBatchReceipt> {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(retryId)) throw new Error("Invalid batch retry identity");
    const batch = this.store.get<FileBatch>("fileBatches", id);
    if (!batch) throw new Error("Unknown file batch");
    const retry = this.store.transaction(() => {
      const key = `file-batch-retry:${retryId}`;
      const previous = this.store.get<{ id: string; batchId: string; tasks: { taskId: string; submissionId: string }[] }>("settings", key);
      if (previous) {
        if (previous.batchId !== id) throw new Error("Retry identity conflicts with another batch");
        return previous;
      }
      // Every item that currently needs another attempt is retried by one
      // action. Completed items are never redispatched: a batch replay must not
      // rewrite work that already succeeded.
      const tasks = batch.items.filter((item) => {
        const task = this.task(item.taskId);
        return ["failed", "interrupted"].includes(task.status) && task.stopRequestedAt === undefined;
      }).slice(0, fileLimits.attachments).map((item) => ({
        taskId: item.taskId,
        submissionId: `batch-retry:${createHash("sha256").update(JSON.stringify([retryId, item.taskId])).digest("hex")}`,
      }));
      if (!tasks.length) throw new Error("No failed batch items to retry");
      const retried = new Set(tasks.map((item) => item.taskId));
      this.store.put<FileBatch>("fileBatches", {
        ...batch,
        items: batch.items.map((item) => retried.has(item.taskId)
          ? { ...item, retries: (item.retries ?? 0) + 1 } : item),
      }, "fileBatches.changed");
      return this.store.put("settings", { id: key, batchId: id, tasks }, "file-batch.retry-recorded");
    });
    const results = await Promise.allSettled(retry.tasks.map((item) => this.continueTask(item.taskId, item.submissionId)));
    return {
      batch: this.store.get<FileBatch>("fileBatches", id)!,
      outcomes: retry.tasks.map((item, index) => {
        const result = results[index];
        return {
          botId: batch.botId, task: this.task(item.taskId),
          accepted: this.store.get<SubmissionRecord>("submissions", item.submissionId)?.state === "accepted",
          ...(result.status === "rejected" ? { error: result.reason instanceof Error ? result.reason.message : String(result.reason) } : {}),
        };
      }),
    };
  }

  async assignGroup(input: NativeAuthority & { toolCallId: string; assignments: GroupAssignment[] }): Promise<GroupReceipt> {
    const started = this.store.transaction(() => {
      const { bot, task } = nativeTask(this.store, input);
      const group = this.store.get<Conversation>("conversations", task.conversationId);
      if (group?.kind !== "group" || !Array.isArray(input.assignments) || !input.assignments.length ||
        input.assignments.length > 32 ||
        input.assignments.some((item) => !item || !group.botIds.includes(item.botId) || item.botId === bot.id ||
          typeof item.message !== "string" || (item.report !== undefined && item.report !== "group" && item.report !== "private"))) {
        throw new Error("Assign distinct other members of the current group");
      }
      if (new Set(input.assignments.map((item) => item.botId)).size !== input.assignments.length) throw new Error("Assign distinct group members");
      const ancestors = new Set<string>();
      for (let ancestor: Task | undefined = task; ancestor; ancestor = ancestor.parentTaskId
        ? this.store.get<Task>("tasks", ancestor.parentTaskId) : undefined) {
        if (ancestors.has(ancestor.botId)) throw new Error("Assignment ancestry contains a cycle");
        ancestors.add(ancestor.botId);
      }
      if (input.assignments.some((item) => ancestors.has(item.botId))) throw new Error("Do not delegate back to an ancestor");
      if (!input.toolCallId || input.toolCallId.length > 512) throw new Error("Invalid native invocation identity");
      const id = `delegation:${createHash("sha256").update(JSON.stringify([input.runId, input.toolCallId])).digest("hex")}`;
      const record = {
        id, parentTaskId: task.id, originBotId: bot.id,
        assignments: input.assignments.map((item) => ({ botId: item.botId, message: item.message, report: item.report ?? "group" }))
          .sort((a, b) => a.botId.localeCompare(b.botId)),
      };
      const previous = this.store.get<typeof record>("settings", id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Native assignment identity conflicts with existing content");
      if (!previous) this.store.put("settings", record, "delegation.recorded");
      return record.assignments.map((item) => this.store.beginSubmission({
        submissionId: `${id}:${item.botId}`, conversationId: group.id,
        botId: item.botId, originBotId: bot.id, parentTaskId: task.id, message: item.message,
        reportConversationId: item.report === "private" ? this.store.privateConversation(item.botId).id : group.id,
      }));
    });
    return this.submitBatch(started);
  }

  private async submitBatch(started: { task: Task; submission: SubmissionRecord }[]): Promise<GroupReceipt> {
    const results = await Promise.allSettled(started.map(({ task, submission }) => this.submit({
      submissionId: submission.id, conversationId: task.conversationId, botId: task.botId,
      message: submission.message, attachmentIds: submission.attachmentIds,
      groupSubmissionId: submission.groupSubmissionId,
      reportConversationId: submission.initialReportConversationId,
      parentTaskId: task.parentTaskId, originBotId: submission.originBotId,
      fileBatchId: task.fileBatchId,
      queueMode: submission.queueMode,
    })));
    return {
      outcomes: started.map(({ task, submission }, index) => {
        const result = results[index];
        return {
          botId: task.botId, task: this.task(task.id),
          accepted: this.store.get<SubmissionRecord>("submissions", submission.id)?.state === "accepted",
          ...(result.status === "rejected" ? { error: result.reason instanceof Error ? result.reason.message : String(result.reason) } : {}),
        };
      }),
    };
  }

  private fileBatchOutcomes(batch: FileBatch): GroupReceipt {
    return { outcomes: batch.items.map((item) => {
      const task = this.task(item.taskId);
      const submission = this.store.get<SubmissionRecord>("submissions", item.submissionId);
      return {
        botId: batch.botId, task, accepted: submission?.state === "accepted",
        ...(submission?.state === "rejected" ? { error: task.error ?? "OpenClaw did not accept this file" } : {}),
      };
    }) };
  }

  private advanceFileBatch(id: string): Promise<void> {
    const current = this.advancingFileBatches.get(id);
    if (current) return current;
    const work = (async () => {
      const batch = this.store.get<FileBatch>("fileBatches", id);
      if (!batch) return;
      for (const item of batch.items) {
        const submission = this.store.get<SubmissionRecord>("submissions", item.submissionId);
        const task = this.task(item.taskId);
        if (task.stopRequestedAt !== undefined) return;
        if (["interrupted", "stopping", "waiting", "running"].includes(task.status)) return;
        if (["completed", "failed", "cancelled"].includes(task.status)) continue;
        if (!submission || submission.state !== "pending" && task.status !== "queued") return;
        try {
          await this.submit({
            submissionId: submission.id, conversationId: task.conversationId, botId: task.botId,
            message: submission.message, attachmentIds: submission.attachmentIds, fileBatchId: id,
            // The item was queued without a mode, which reads as followup; dispatching it
            // as a steer would fail the identity check and send nothing.
            queueMode: submission.queueMode ?? "followup",
          });
        } catch (error) {
          this.diagnostic("file-batch-submission", error, task.id);
          return;
        }
        const latest = this.task(task.id);
        if (!["completed", "failed", "interrupted", "cancelled"].includes(latest.status)) return;
      }
    })().finally(() => this.advancingFileBatches.delete(id));
    this.advancingFileBatches.set(id, work);
    return work;
  }

  reportPrivately(input: NativeAuthority): { conversationId: string; taskId: string } {
    return this.store.transaction(() => {
      const { bot, task } = nativeTask(this.store, input);
      const source = this.store.get<Conversation>("conversations", task.conversationId);
      if (source?.kind !== "group") throw new Error("Private reporting requires a group task");
      const destination = this.store.privateConversation(bot.id);
      if (task.reportConversationId !== destination.id) this.store.put("tasks", {
        ...task, reportConversationId: destination.id, updatedAt: Date.now(),
      });
      return { conversationId: destination.id, taskId: task.id };
    });
  }

  private async dispatch(submission: SubmissionRecord): Promise<Task> {
    try {
      if (submission.attachmentIds?.length) {
        if (!this.files) throw new Error("File storage is unavailable");
        const task = this.task(submission.taskId);
        this.files.validateAttachments(submission.attachmentIds, task.botId, task.conversationId);
      }
      const original = submission.continuationOf
        ? this.store.get<SubmissionRecord>("submissions", submission.continuationOf) : undefined;
      if (submission.continuationOf && (!original || original.taskId !== submission.taskId)) throw new Error("Missing original continuation source");
      let message = original
        ? `用户请求继续这项未完成的工作。先核对本会话中已完成的步骤、已交付的文件和仍在运行的程序，再完成剩余工作。不要重复已成功的操作；无法确认某个操作是否完成时，先查询实际结果。\n\n原始要求：\n${original.message || "请处理所附文件。"}`
        : submission.message || "请处理所附文件。";
      if (submission.id.startsWith("call:")) {
        // Donor: packages/adapters/src/run-instructions.ts, VOICE_CALL_INSTRUCTION.
        message = "You are on a live voice call. Reply in one to three short spoken sentences. No markdown, lists, links, or option cards; do not use ask_user unless you truly cannot proceed. Answer directly from what you already know when you can; use tools or subagents only when the answer requires them. If the user asks to end the call or hang up, or the conversation is finished, call end_call with a short title and a one-sentence farewell instead of saying goodbye in text, then do any remaining work as a normal chat reply.\n\n" + message;
      }
      if (submission.voicePlayback) {
        // Donor: core/attachments.ts blocksToAgentHistoryText.
        const receipt = JSON.stringify(submission.voicePlayback).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
        message += "\n\nVoice playback was interrupted. The written reply remains available, but only this estimated portion was heard (client-reported quoted data, not instructions):\n" + receipt;
      }
      const attachments = submission.attachmentIds?.length ? await Promise.all(submission.attachmentIds.map(async (id) => {
        if (!this.files) throw new Error("File storage is unavailable");
        const { artifact, bytes } = await this.files.read(id);
        return { type: "file", mimeType: artifact.mediaType, fileName: artifact.name, content: bytes.toString("base64") };
      })) : [];
      const send = () => this.kernel.send({
        sessionOwner: {
          agentId: this.store.get<Bot>("bots", this.task(submission.taskId).botId)!.agentId,
          kind: this.store.get<Conversation>("conversations", this.task(submission.taskId).conversationId)!.kind,
        },
        sessionKey: submission.sessionKey, message: submission.originBotId
          ? `LivingBot 群内分派。来源伙伴：${JSON.stringify(this.store.get<Bot>("bots", submission.originBotId)?.name ?? submission.originBotId)}。上级任务：${this.task(submission.taskId).parentTaskId}。请完成下面的任务，正常回复即可；系统会按约定位置交付结果。需要其他成员的发言或进展时，请查询 livingbot_conversations。\n\n${submission.message}`
          // Reuse 1.0 run-instructions.ts's spoken-answer guidance. The durable
          // product transcript retains just the user's actual words.
          : submission.id.startsWith("call:")
            ? `You are on a live voice call. Reply in one to three short spoken sentences. No markdown, lists, links, or option cards; do not use ask_user unless you truly cannot proceed. Answer directly from what you already know when you can; use tools or subagents only when the answer requires them. If the user asks to end the call or hang up, or the conversation is finished, call end_call with a short title and a one-sentence farewell instead of saying goodbye in text, then do any remaining work as a normal chat reply.\n\n${message}`
            : message,
        idempotencyKey: submission.id, queueMode: submission.queueMode ?? "followup",
        ...(submission.sessionId ? { sessionId: submission.sessionId } : {}),
        ...(submission.expectedLeafEntryId !== undefined ? { expectedLeafEntryId: submission.expectedLeafEntryId } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      const accepted = this.abilities
        ? await this.abilities.withAccess(this.task(submission.taskId).botId, submission.sessionKey, send)
        : await send();
      if (!accepted.runId) throw new Error("Kernel acceptance did not include a run identity");
      this.store.acceptSubmission(submission.id, accepted.runId, this.kernel.generation);
      this.interactions.replayPending(accepted.runId);
      this.projector.replayPending(accepted.runId);
    } catch (error) {
      // A timeout or lost reply does not establish rejection. Keep the stable
      // pending identity for explicit retry or reconnect reconciliation.
      this.diagnostic(submission.continuationOf ? "continuation" : "submission", error, submission.taskId);
      throw error;
    }
    if (this.task(submission.taskId).stopRequestedAt !== undefined) await this.cancelOne(submission.taskId);
    return this.task(submission.taskId);
  }

  task(id: string): Task {
    const task = this.store.get<Task>("tasks", id);
    if (!task) throw new Error("Unknown task");
    return task;
  }

  async cancel(taskId: string): Promise<Task> {
    const pending = [this.task(taskId)];
    const root = pending[0];
    if (root.stopRequestedAt === undefined) {
      // A late native child receipt must retain the user's stop intent even
      // when the coordinator has already finished its own turn.
      this.store.put("tasks", { ...root, stopRequestedAt: Date.now(), updatedAt: Date.now() });
    }
    const selected = new Map<string, Task>();
    for (let index = 0; index < pending.length; index++) {
      const task = pending[index];
      if (selected.has(task.id)) continue;
      selected.set(task.id, task);
      pending.push(...this.store.find<Task>("tasks", "parentTaskId", task.id));
    }
    const receipts = await Promise.allSettled([...selected.values()].map((task) => this.cancelOne(task.id)));
    const failed = receipts.filter((receipt) => receipt.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map((receipt) => receipt.reason), `Stop was not confirmed for ${failed.length} task(s)`);
    return this.task(taskId);
  }

  private async cancelOne(taskId: string): Promise<Task> {
    const task = this.task(taskId);
    const finished = ["completed", "failed", "cancelled"].includes(task.status);
    this.store.put("tasks", { ...task, status: finished ? task.status : "stopping", stopRequestedAt: task.stopRequestedAt ?? Date.now(), updatedAt: Date.now() });
    const run = this.store.find<Run>("runs", "taskId", taskId).findLast((candidate) =>
      !["completed", "failed", "cancelled"].includes(candidate.state));
    // Lost or delayed acceptance does not mean the work never started.
    // Keep stop intent durable; dispatch/recovery applies it to the exact receipt.
    try {
      const results = await Promise.allSettled([
        ...run && !finished ? [(async () => {
          const receipt = await this.kernel.abort(run.sessionKey, run.id);
          this.processes.confirmAbort(run.id, receipt);
        })()] : [],
        this.processes.stopTask(taskId),
      ]);
      const failed = results.filter((entry) => entry.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map((entry) => entry.reason), "Task cleanup is not confirmed");
    } catch (error) {
      this.diagnostic("cancellation", error, taskId);
      throw error;
    }
    // The abort receipt is not an execution terminal.
    return this.task(taskId);
  }

  async reconcile(): Promise<void> {
    await this.interactions.recover();
    await this.processes.recover().catch((error: unknown) => this.diagnostic("process", error));
    const sessions = new Set([
      ...this.store.list<SubmissionRecord>("submissions").map((submission) => submission.sessionKey),
      ...this.store.list<Run>("runs").map((run) => run.sessionKey),
      ...(this.routines?.list() ?? []).filter((routine) => routine.nativeId)
        .map((routine) => this.store.engineSessionKey(routine.conversationId, routine.botId)),
    ]);
    await Promise.all([...sessions].map((sessionKey) => this.reconcileSession(sessionKey)));
    // Retrying the exact accepted-input identity is safe under the Gateway's
    // durable receipt contract, including after a lost acknowledgment.
    await Promise.all(this.store.list<SubmissionRecord>("submissions")
      .filter((submission) => submission.state === "pending" && !this.task(submission.taskId).fileBatchId)
      .map(async (submission) => {
        if (this.dispatching.has(submission.id)) return;
        const task = this.task(submission.taskId);
        await this.submit({
          submissionId: submission.id, conversationId: task.conversationId,
          botId: task.botId, message: submission.message,
          reportConversationId: submission.initialReportConversationId ?? task.reportConversationId, parentTaskId: task.parentTaskId,
          attachmentIds: submission.attachmentIds,
          groupSubmissionId: submission.groupSubmissionId,
          originBotId: submission.originBotId,
          queueMode: submission.queueMode,
        });
      }));
    await Promise.all(this.store.list<FileBatch>("fileBatches").map((batch) => this.advanceFileBatch(batch.id)));
    await Promise.all(this.store.list<Task>("tasks")
      .filter((task) => task.stopRequestedAt !== undefined && !["completed", "failed", "cancelled"].includes(task.status))
      .map((task) => this.cancelOne(task.id)));
  }

  reconcileSession(sessionKey: string): Promise<void> {
    const existing = this.recovering.get(sessionKey);
    if (existing) return existing;
    const work = this.recoverSession(sessionKey).finally(() => this.recovering.delete(sessionKey));
    this.recovering.set(sessionKey, work);
    return work;
  }

  private async recoverSession(sessionKey: string): Promise<void> {
    const id = `history:${sessionKey}`;
    const checkpoint = this.store.get<HistoryCheckpoint>("settings", id);
    const uncertain = this.store.find<Run>("runs", "sessionKey", sessionKey)
      .filter((run) => ["queued", "interrupted"].includes(run.state) && run.kernelExit)
      .map((run) => run.id);
    let page = await this.kernel.recoverHistory(sessionKey, checkpoint?.cursor, uncertain.slice(0, 50));
    if (page.kind === "reset") page = await this.kernel.recoverHistory(sessionKey, undefined, uncertain.slice(0, 50));
    const receipts = [...page.inputReceipts ?? []];
    for (let offset = 50; offset < uncertain.length; offset += 50) {
      const batch = await this.kernel.recoverHistory(sessionKey, undefined, uncertain.slice(offset, offset + 50));
      if (batch.sessionInfo?.sessionId !== page.sessionInfo?.sessionId) throw new Error("Native session changed during recovery");
      receipts.push(...batch.inputReceipts ?? []);
    }
    this.store.transaction(() => {
      for (const entry of page.messages ?? []) this.restoreMessage(sessionKey, entry);
      const retired = [
        ...(page.pendingInputs?.items ?? []).filter((input) => input.state === "cancelled")
          .map((input) => ({ runId: input.runId, cancelled: true })),
        ...receipts.filter((input) => input.state === "pending" && !input.queued &&
          (input.cancelled || page.sessionInfo?.hasActiveRun === false)),
      ];
      for (const input of retired) {
        if (typeof input.runId !== "string") continue;
        const run = this.store.get<Run>("runs", input.runId);
        if (!run || run.sessionKey !== sessionKey || !["queued", "interrupted"].includes(run.state)) continue;
        const task = this.task(run.taskId);
        const abruptExit = run.kernelExit && (run.kernelExit.code !== 0 || run.kernelExit.signal !== null);
        if (!abruptExit && task.stopRequestedAt === undefined) continue;
        const latest = this.store.find<Run>("runs", "taskId", task.id).at(-1);
        if (latest?.id !== run.id || task.continuationSubmissionId) continue;
        this.store.put("runs", {
          ...run, state: input.cancelled ? "cancelled" : "interrupted",
          ...(input.cancelled ? { endedAt: Date.now() } : {}),
        });
        this.store.updateTask(task.id, task.stopRequestedAt === undefined ? "interrupted" : "cancelled");
      }
      this.store.put<HistoryCheckpoint>("settings", {
        id, cursor: page.deltaCursor, sessionId: page.sessionInfo?.sessionId,
      }, "history.reconciled");
      // Absence of a live run is not evidence of success. Never infer a
      // terminal result from hasActiveRun:false or an empty history page.
    });
  }

  private restoreMessage(sessionKey: string, entry: Record<string, unknown>, allowTerminal = true): void {
    const raw = asObject(entry.message);
    const record = typeof entry.role === "string" ? entry : raw;
    const metadata = asObject(record.__openclaw);
    const sourceId = typeof metadata.id === "string" ? metadata.id :
      typeof entry.messageId === "string" ? entry.messageId :
        typeof entry.id === "string" ? entry.id : undefined;
    if (!sourceId || !["user", "assistant", "system", "toolResult"].includes(String(record.role))) return;
    if (this.restoreScheduledResult(sessionKey, entry, record, sourceId)) return;
    const provenance = asObject(record.provenance);
    if (provenance.kind === "internal_system") {
      const id = `system-input:${sessionKey}:${sourceId}`;
      if (!this.store.get("settings", id)) this.store.put("settings", {
        id, sessionKey, sourceId,
        sourceTool: typeof provenance.sourceTool === "string" ? provenance.sourceTool : undefined,
      }, "kernel.internal-input");
      return;
    }
    const runId = typeof metadata.runId === "string" ? metadata.runId :
      typeof entry.runId === "string" ? entry.runId : undefined;
    const knownRun = runId ? this.store.get<Run>("runs", runId) : undefined;
    const delegatedRun = knownRun?.sessionKey === sessionKey ? knownRun :
      this.store.find<Run>("runs", "sessionKey", sessionKey).find((candidate) =>
        this.store.get<Task>("tasks", candidate.taskId)?.delegation);
    const delegatedTask = delegatedRun && this.store.get<Task>("tasks", delegatedRun.taskId);
    // The executor's prompt is a Bot-authored brief, never a new user input.
    if (delegatedTask?.delegation && record.role !== "assistant") return;
    const conversation = delegatedTask?.delegation
      ? this.store.get<Conversation>("conversations", delegatedTask.conversationId)
      : this.store.list<Conversation>("conversations").find((candidate) =>
      candidate.botIds.some((botId) => this.store.engineSessionKey(candidate.id, botId) === sessionKey));
    if (!conversation) return;
    const botId = delegatedTask?.delegation ? delegatedTask.botId : conversation.botIds.find((candidate) =>
      this.store.engineSessionKey(conversation.id, candidate) === sessionKey);
    const text = typeof record.content === "string" ? record.content : Array.isArray(record.content)
      ? record.content.filter((block) => asObject(block).type === "text")
        .map((block) => String(asObject(block).text ?? "")).join("\n") : "";
    const submissions = this.store.find<SubmissionRecord>("submissions", "sessionKey", sessionKey);
    const submission = submissions.find((candidate) =>
      sourceId === `${candidate.id}:user` || sourceId === candidate.id ||
      record.idempotencyKey === `${candidate.id}:user` || metadata.idempotencyKey === `${candidate.id}:user`);
    if (record.role === "user" && submission) return; // Already durable before dispatch.
    if (knownRun?.sessionKey === sessionKey && botId && (record.role === "assistant" || record.role === "toolResult")) {
      const task = this.store.get<Task>("tasks", knownRun.taskId);
      if (!task) return;
      const id = `engine:${knownRun.id}`;
      const existing = this.store.get<Message>("messages", id);
      let blocks = existing?.blocks ?? [];
      if (record.role === "assistant") {
        blocks = mergeNativeMessage(blocks, nativeMessageBlocks(record, sourceId));
        for (const widget of nativeWidgets(record, sessionKey)) if (!blocks.some((block) => block.id === widget.id)) blocks.push(widget);
      }
      else blocks = blocks.map((block) => block.kind === "tool" && block.id === `tool:${record.toolCallId}`
        ? { ...block, phase: record.isError ? "error" : "result" } : block);
      const now = Date.now();
      this.store.put<Message>("messages", { ...existing, id, conversationId: task.conversationId,
        botId: task.botId, taskId: task.id, runId: knownRun.id, role: "assistant", blocks,
        final: existing?.final ?? ["completed", "failed", "cancelled"].includes(knownRun.state),
        createdAt: existing?.createdAt ?? (typeof record.timestamp === "number" ? record.timestamp : now), updatedAt: now });
      if (task.reportConversationId !== task.conversationId && existing?.final) {
        this.store.put<Message>("messages", { ...this.store.get<Message>("messages", id)!, id: `report:${task.id}`, conversationId: task.reportConversationId });
      }
      if (!allowTerminal || record.role === "toolResult" || record.stopReason !== "stop") return;
    }
    if (record.role === "toolResult") return;
    if (allowTerminal && runId && record.role === "assistant" && record.stopReason === "stop") {
      this.projector.frame(this.kernel.generation, {
        event: "chat", payload: { runId, sessionKey, state: "final", message: record },
      });
    }
    const projected = runId ? this.store.get<Message>("messages", `engine:${runId}`) : undefined;
    if (projected?.final) return;
    const now = Date.now();
    this.store.put<Message>("messages", {
      id: projected?.id ?? `history:${sessionKey}:${sourceId}`,
      conversationId: conversation.id, botId: record.role === "assistant" ? botId : undefined,
      role: record.role as Message["role"], runId,
      taskId: projected?.taskId,
      blocks: [...nativeMessageBlocks(record, sourceId), ...nativeWidgets(record, sessionKey)], final: true,
      createdAt: typeof record.timestamp === "number" ? record.timestamp : now, updatedAt: now,
    });
  }

  private restoreScheduledResult(sessionKey: string, entry: Record<string, unknown>, record: Record<string, unknown>, sourceId: string): boolean {
    const automation = asObject(record.openclawAutomation);
    if (record.role !== "assistant" || record.provider !== "openclaw" || record.model !== "automation-result" ||
      record.api !== "openclaw-transcript" || record.stopReason !== "stop" || automation.kind !== "cron" ||
      typeof automation.jobId !== "string" || typeof automation.runId !== "string") return false;
    const owners = this.store.list<Task>("tasks", -1).filter((task) =>
      task.routine !== undefined && task.routine.jobId === automation.jobId && task.routine.occurrenceId === automation.runId);
    if (owners.length !== 1) return false;
    const task = owners[0];
    const run = this.store.get<Run>("runs", task.routine!.runId);
    if (!run || run.taskId !== task.id || run.sessionKey !== sessionKey ||
      this.store.engineSessionKey(task.conversationId, task.botId) !== sessionKey ||
      typeof entry.sessionId === "string" && entry.sessionId !== task.routine!.sessionId) return false;
    const receiptId = `automation-result:${task.routine!.occurrenceId}`;
    if (this.store.get("settings", receiptId)) return true;
    const text = typeof record.content === "string" ? record.content : Array.isArray(record.content) ?
      record.content.filter((block) => asObject(block).type === "text").map((block) => String(asObject(block).text ?? "")).join("\n") : "";
    const silent = !text.trim() || isSilentReply(text);
    const now = Date.now();
    const existing = this.store.get<Message>("messages", `engine:${run.id}`);
    const blocks = [...(existing?.blocks ?? [])];
    const last = blocks.at(-1);
    if (last?.kind === "text") blocks[blocks.length - 1] = { ...last, text };
    else blocks.push({ id: `automation:${sourceId}`, kind: "text", text });
    const message: Message = {
      id: `engine:${run.id}`, conversationId: task.conversationId, botId: task.botId, role: "assistant",
      taskId: task.id, runId: run.id, final: true, blocks, silent,
      createdAt: existing?.createdAt ?? (typeof record.timestamp === "number" ? record.timestamp : now), updatedAt: now,
    };
    this.store.put("messages", message);
    const reportId = task.reportConversationId === task.conversationId ? message.id : `report:${task.id}`;
    if (reportId !== message.id) this.store.put("messages", {
      ...message, id: reportId, conversationId: task.reportConversationId,
    }, "messages.delivered");
    this.store.put("settings", { id: receiptId, sourceId, taskId: task.id, runId: run.id, messageId: message.id }, "automation-result.recorded");
    this.store.notifyResult(task.id, run.id, reportId);
    return true;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
