import { randomUUID } from "node:crypto";
import type { Bot, ContextPassage, ContextShare, Conversation, Message, Task } from "./contracts.ts";
import { nativeTask } from "./authority.ts";
import type { WorkbenchStore } from "./store.ts";

export interface ContextSelector {
  /** A configured LLM selects relevant source identities; it cannot widen access. */
  select(input: { query: string; passages: ContextPassage[]; limit: number }): Promise<string[]>;
}

export class ConversationContext {
  private readonly store: WorkbenchStore;

  constructor(store: WorkbenchStore) { this.store = store; }

  /** Called only by the native tool transport, with host-bound identities. */
  invoke(input: {
    agentId: string; sessionKey: string; runId: string;
    operation: "list" | "read"; conversationId?: string; before?: string; limit?: number;
  }): unknown {
    const { bot, task } = nativeTask(this.store, input);
    const destination = this.conversation(task.conversationId);
    if (!destination.botIds.includes(bot.id)) throw new Error("Bot is not a destination participant");
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid context bound");
    const grants = this.store.list<ContextShare>("contextShares").filter((share) =>
      !share.revokedAt && share.destinationConversationId === destination.id);
    const permitted = (source: Conversation) => source.id === destination.id ||
      (destination.kind === "private" && source.botIds.includes(bot.id));
    if (input.operation === "list") {
      const conversations = this.store.list<Conversation>("conversations").filter((source) =>
        permitted(source) || grants.some((share) => share.sourceConversationId === source.id))
        .sort((a, b) => a.id.localeCompare(b.id));
      const offset = input.before ? conversations.findIndex((item) => item.id === input.before) + 1 : 0;
      if (input.before && !offset) throw new Error("Unknown context cursor");
      const page = conversations.slice(offset, offset + limit);
      return {
        conversations: page.map((source) => ({
          id: source.id, title: source.title, scope: permitted(source) ? source.kind : "shared",
          ...(permitted(source) ? { members: this.members(source) } : {}),
        })),
        ...(offset + page.length < conversations.length ? { nextBefore: page.at(-1)!.id } : {}),
      };
    }
    if (input.operation !== "read" || !input.conversationId) throw new Error("Select a source conversation");
    const source = this.conversation(input.conversationId);
    const shared = new Set(grants.filter((share) => share.sourceConversationId === source.id)
      .flatMap((share) => share.messageIds));
    if (!permitted(source) && !shared.size) throw new Error("Conversation is outside this audience");
    const messages = this.store.messages(source.id).filter((message) =>
      message.final && ["user", "assistant"].includes(message.role) &&
      (permitted(source) || shared.has(message.id)) &&
      message.blocks.some((block) => block.kind === "text" && block.text))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const offset = input.before ? messages.findIndex((message) => message.id === input.before) + 1 : 0;
    if (input.before && !offset) throw new Error("Unknown context cursor");
    const page = messages.slice(offset, offset + limit);
    return {
      conversationId: source.id, title: source.title, scope: permitted(source) ? source.kind : "shared",
      ...(permitted(source) ? {
        members: this.members(source),
        tasks: this.store.find<Task>("tasks", "conversationId", source.id)
          .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit)
          .map((task) => ({
            id: task.id, botId: task.botId, botName: this.store.get<Bot>("bots", task.botId)?.name,
            title: task.title, status: task.status, updatedAt: task.updatedAt,
            ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
          })),
      } : {}),
      messages: page.map((message) => {
        const text = message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
        return {
          messageId: message.id, role: message.role, createdAt: message.createdAt,
          ...this.author(message),
          text: text.slice(0, 4000), truncated: text.length > 4000,
        };
      }),
      ...(offset + page.length < messages.length ? { nextBefore: page.at(-1)!.id } : {}),
    };
  }

  share(input: {
    id?: string; sourceConversationId: string; destinationConversationId: string; messageIds: string[];
  }): ContextShare {
    const source = this.conversation(input.sourceConversationId);
    const destination = this.conversation(input.destinationConversationId);
    if (source.id === destination.id) throw new Error("Source and destination must differ");
    if (!input.messageIds.length || input.messageIds.length > 100) throw new Error("Select 1–100 messages");
    const messageIds = [...new Set(input.messageIds)];
    if (input.id !== undefined && !/^[a-zA-Z0-9-]{16,80}$/.test(input.id)) throw new Error("Invalid sharing identity");
    const id = input.id ?? randomUUID();
    const previous = this.store.get<ContextShare>("contextShares", id);
    if (previous) {
      if (previous.sourceConversationId !== source.id || previous.destinationConversationId !== destination.id ||
        JSON.stringify([...previous.messageIds].sort()) !== JSON.stringify([...messageIds].sort())) {
        throw new Error("Sharing identity conflicts with existing content");
      }
      return previous;
    }
    for (const id of messageIds) {
      const message = this.store.get<Message>("messages", id);
      if (!message || message.conversationId !== source.id || !message.final) throw new Error("Message is not an available source");
    }
    return this.store.put<ContextShare>("contextShares", {
      id, sourceConversationId: source.id,
      destinationConversationId: destination.id, messageIds, createdAt: Date.now(),
    });
  }

  revoke(shareId: string): ContextShare {
    const share = this.store.get<ContextShare>("contextShares", shareId);
    if (!share) throw new Error("Unknown context share");
    return this.store.put("contextShares", { ...share, revokedAt: share.revokedAt ?? Date.now() });
  }

  candidates(input: { botId: string; destinationConversationId: string; limit?: number }): ContextPassage[] {
    const destination = this.conversation(input.destinationConversationId);
    if (!destination.botIds.includes(input.botId)) throw new Error("Bot is not a destination participant");
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid context bound");
    const grants = this.store.list<ContextShare>("contextShares")
      .filter((share) => !share.revokedAt && share.destinationConversationId === destination.id);
    const result: ContextPassage[] = [];
    for (const source of this.store.list<Conversation>("conversations")) {
      // A private destination may recall this Bot's own private conversations
      // and its groups. Group destinations never receive private transcripts
      // or another group's transcripts through this implicit path.
      const permitted = source.id === destination.id ||
        (destination.kind === "private" && source.botIds.includes(input.botId));
      const shared = new Set(grants.filter((grant) => grant.sourceConversationId === source.id)
        .flatMap((grant) => grant.messageIds));
      if (!permitted && !shared.size) continue;
      for (const message of this.store.messages(source.id)) {
        if (!message.final || !["user", "assistant"].includes(message.role) ||
          (!permitted && !shared.has(message.id))) continue;
        // Reasoning, raw tool outputs and hidden metadata are not recalled as
        // ordinary conversational facts.
        const text = message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
        if (!text) continue;
        result.push({
          messageId: message.id, conversationId: source.id, conversationTitle: source.title,
          scope: permitted ? source.kind : "shared", role: message.role,
          ...this.author(message),
          text: text.slice(0, 16_000), createdAt: message.createdAt,
        });
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async relevant(input: {
    botId: string; destinationConversationId: string; query: string; limit?: number;
  }, selector: ContextSelector): Promise<ContextPassage[]> {
    const limit = input.limit ?? 12;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("Invalid relevance bound");
    const passages = this.candidates({ botId: input.botId, destinationConversationId: input.destinationConversationId });
    const selected = await selector.select({ query: input.query, passages, limit });
    if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string")) throw new Error("Invalid relevance selection");
    const unique = [...new Set(selected)];
    if (unique.length > limit) throw new Error("Relevance selection exceeds its bound");
    const permitted = new Map(passages.map((passage) => [passage.messageId, passage]));
    if (unique.some((id) => !permitted.has(id))) throw new Error("Relevance selection references an unauthorized source");
    return unique.map((id) => permitted.get(id)!);
  }

  private members(conversation: Conversation): { botId: string; name: string }[] {
    return conversation.botIds.flatMap((id) => {
      const bot = this.store.get<Bot>("bots", id);
      return bot ? [{ botId: bot.id, name: bot.name }] : [];
    });
  }

  private author(message: Message): { botId?: string; botName?: string } {
    if (message.role !== "assistant" || !message.botId) return {};
    const bot = this.store.get<Bot>("bots", message.botId);
    return { botId: message.botId, ...(bot ? { botName: bot.name } : {}) };
  }

  private conversation(id: string): Conversation {
    const conversation = this.store.get<Conversation>("conversations", id);
    if (!conversation) throw new Error("Unknown conversation");
    return conversation;
  }
}
