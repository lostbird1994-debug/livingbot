// Local-store adaptation of 1.0 call-request.ts and routes/threads.ts.
import { randomUUID } from "node:crypto";
import type { Block, Conversation, Message, SubmissionRecord } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import { nativeTask } from "../../../packages/workbench/src/authority.ts";
import type { NativeAuthority } from "../../../packages/workbench/src/authority.ts";
// Donor: core/call-nonce.ts. Kept local because its browser .js imports are not
// executable in the desktop's direct TypeScript runtime.
function callIdFromClientNonce(nonce?: string): string | undefined {
  if (!nonce?.startsWith("call:")) return undefined;
  const rest = nonce.slice(5);
  const suffixAt = rest.lastIndexOf(":");
  return suffixAt === -1 ? undefined : rest.slice(0, suffixAt) || undefined;
}

type CallRequest = Extract<Block, { kind: "call_request" }>;
const HANG_UP_PROMPT = "The voice call just ended because the user hung up. First call end_call with a short title for the call (leave farewell empty). Then, if anything the user asked for during the call is still unfinished, complete it now as a normal chat reply with full formatting. If nothing is pending, reply with one short sentence.";

export function localCalls(service: WorkbenchService) {
  const store = service.store;
  function target(botId: string) {
    return store.privateConversation(botId);
  }
  function validateId(callId: string) {
    if (!callId || callId.length > 200 || callId.includes(":")) throw new Error("Invalid call identity");
  }
  function marker(conversation: Conversation, callId: string, input: { title?: string; farewell?: string; durationSeconds?: number }) {
    validateId(callId);
    const id = `call:${callId}:marker`;
    const previous = store.get<Message>("messages", id);
    if (previous && previous.conversationId !== conversation.id) throw new Error("Call belongs to another conversation");
    if (previous) {
      // Donor: 1.0 endCallFromTool updates the user's existing hang-up marker.
      // A retry without a farewell must not erase one already supplied.
      const title = input.title?.trim().slice(0, 120);
      const farewell = input.farewell?.trim().slice(0, 500);
      const blocks = previous.blocks.map((block) =>
        block.kind === "voice_call" && block.callId === callId
          ? { ...block, ...(title !== undefined ? { title } : {}), ...(farewell ? { farewell } : {}) }
          : block);
      if (JSON.stringify(blocks) === JSON.stringify(previous.blocks)) return previous;
      const message = store.put<Message>("messages", { ...previous, blocks, updatedAt: Date.now() });
      const block = blocks.find((item) => item.kind === "voice_call" && item.callId === callId)!;
      store.recordEvent("thread.call.ended", id, { conversationId: conversation.id, ...block });
      return message;
    }
    const now = Date.now();
    const block: Block = { id: "call", kind: "voice_call", callId,
      title: input.title?.trim().slice(0, 120) || "语音通话", farewell: input.farewell?.trim().slice(0, 500) || "",
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}) };
    const message = store.put<Message>("messages", { id, conversationId: conversation.id, botId: conversation.botIds[0],
      role: "assistant", clientNonce: id, blocks: [block], final: true, createdAt: now, updatedAt: now });
    store.recordEvent("thread.call.ended", id, { conversationId: conversation.id, ...block });
    return message;
  }
  function settle(botId: string, callId: string, status: CallRequest["status"]) {
    const conversation = target(botId);
    validateId(callId);
    const reference = store.get<{ messageId: string }>("settings", `call-request:${callId}`);
    const message = reference && store.get<Message>("messages", reference.messageId);
    const block = message?.blocks.find((item): item is CallRequest => item.kind === "call_request");
    if (!message || message.conversationId !== conversation.id || !block) throw new Error("Call request not found");
    if (block.status === status) return block;
    if (block.status !== "ringing") throw new Error("This call is no longer ringing");
    const updated = { ...block, status: Date.parse(block.expiresAt) <= Date.now() ? "missed" as const : status };
    store.put("messages", { ...message, blocks: [updated], updatedAt: Date.now() });
    return updated;
  }
  return {
    async rpc(operation: string, input: Record<string, unknown>) {
      const botId = String(input.botId ?? "");
      const callId = String(input.callId ?? "");
      if (operation === "answerCall") {
        const answered = settle(botId, callId, "answered");
        if (answered.status !== "answered") throw new Error("This call is no longer ringing");
        return { opening: answered.opening, reason: answered.reason };
      }
      if (operation === "declineCall") {
        if (!["declined", "missed"].includes(String(input.outcome))) throw new Error("Invalid call outcome");
        settle(botId, callId, input.outcome as "declined" | "missed");
        return { ok: true };
      }
      if (operation !== "endCall") throw new Error("Unknown call operation");
      const conversation = target(botId);
      if (input.durationSeconds !== undefined && (!Number.isInteger(input.durationSeconds) ||
        Number(input.durationSeconds) < 0 || Number(input.durationSeconds) > 604800)) throw new Error("Invalid call duration");
      validateId(callId);
      const previous = store.get<Message>("messages", `call:${callId}:marker`);
      if (previous && previous.conversationId !== conversation.id) throw new Error("Call belongs to another conversation");
      // Donor: 1.0 threads.endCall ignores calls without a durable user turn.
      if (!store.messages(conversation.id).some((message) =>
        message.role === "user" && message.clientNonce?.startsWith(`call:${callId}:`))) return { ok: true };
      marker(conversation, callId, { durationSeconds: input.durationSeconds as number | undefined });
      // A durable submission also makes a retry after a restart finish pending
      // work, without writing another visible user message.
      await service.submit({ submissionId: `call-wrapup:${callId}`, botId, conversationId: conversation.id,
        message: HANG_UP_PROMPT, hiddenInput: true });
      return { ok: true };
    },
    tool(input: NativeAuthority & { operation: string; toolCallId: string; reason?: string; opening?: string; title?: string; farewell?: string }) {
      const { bot, task } = nativeTask(store, input);
      const conversation = store.get<Conversation>("conversations", task.conversationId)!;
      if (conversation.kind !== "private") throw new Error("Calls require a one-to-one chat");
      const submission = store.find<SubmissionRecord>("submissions", "taskId", task.id)[0];
      if (input.operation === "end_call") {
        const callId = callIdFromClientNonce(submission?.id) ??
          (submission?.id.startsWith("call-wrapup:") ? submission.id.slice("call-wrapup:".length) : undefined);
        if (!callId) throw new Error("There is no active call in this turn");
        marker(conversation, callId, input);
        return { ok: true };
      }
      if (input.operation !== "call_user") throw new Error("Unknown call tool");
      if (callIdFromClientNonce(submission?.id) || task.routine) throw new Error("Calls require a one-to-one chat");
      if (!store.list<{ voiceId?: string; disconnected?: boolean }>("voiceCredentials").some((row) => row.voiceId && !row.disconnected))
        throw new Error("Connect a voice provider before calling");
      const id = `call-request:${input.runId}:${input.toolCallId}`;
      const saved = store.get<Message>("messages", id);
      if (saved) return saved.blocks[0];
      const reason = input.reason?.trim().slice(0, 120);
      const opening = input.opening?.trim().slice(0, 240);
      if (!reason || !opening) throw new Error("reason and opening are required");
      return store.transaction(() => {
        if (store.list<Message>("messages", -1).some((message) => message.createdAt > Date.now() - 120000 &&
          message.blocks.some((block) => block.kind === "call_request"))) throw new Error("A call was already requested recently");
        const callId = randomUUID();
        const now = Date.now();
        const block: CallRequest = { id: "request", kind: "call_request", callId, reason, opening,
          status: "ringing", expiresAt: new Date(now + 45000).toISOString() };
        store.put<Message>("messages", { id, conversationId: conversation.id, botId: bot.id, runId: input.runId,
          taskId: task.id, role: "assistant", clientNonce: `call:${callId}:request`, blocks: [block],
          final: true, createdAt: now, updatedAt: now });
        // The call nonce remains the lookup identity used by answer/decline.
        store.put("settings", { id: `call-request:${callId}`, messageId: id });
        return block;
      });
    },
  };
}
