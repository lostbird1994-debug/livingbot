import type { KernelFrame, RuntimeObservation } from "../../kernel-runtime/src/contracts.ts";
import type { Block, Message, Run, SubmissionRecord, Task, TaskStatus } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";
import { recordNativeDelegation } from "./delegations.ts";
import { recordNativeProcess } from "./processes.ts";
import { toolDetail } from "./tool-detail.ts";
import { isSilentReply } from "./reply-content.ts";
import { nativeWidgets } from "./widgets.ts";

const terminal = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textContent(message: unknown): string {
  const record = object(message);
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content.filter((block) => object(block).type === "text")
    .map((block) => String(object(block).text ?? "")).join("\n");
}

function toolBlock(data: Record<string, unknown>, id: string, existing?: Extract<Block, { kind: "tool" }>): Extract<Block, { kind: "tool" }> {
  const detail = toolDetail(data);
  return {
    ...existing, id, kind: "tool", name: String(data.name ?? existing?.name ?? "tool"),
    title: String(data.description ?? data.title ?? existing?.title ?? data.name ?? "工具"),
    phase: String(data.phase ?? "running"), ...(detail ? { detail } : {}),
    ...(typeof data.parentToolCallId === "string" ? { parentId: `tool:${data.parentToolCallId}` } : {}),
  };
}

/** Ordered, durable UI projection. It never dispatches or guesses engine work. */
export class EngineProjector {
  private readonly store: WorkbenchStore;

  constructor(store: WorkbenchStore) {
    this.store = store;
  }

  observe(observation: RuntimeObservation): void {
    if (observation.type === "frame") this.frame(observation.generation, observation.frame);
    else this.store.recordEvent(`kernel.${observation.type}`, "kernel", observation);
    if (observation.type === "exit") {
      this.store.transaction(() => {
        for (const run of this.store.list<Run>("runs")) {
          if (run.generation !== observation.generation || terminal.has(run.state)) continue;
          // Accepted followups without a start fact remain in native custody
          // after either a graceful exit or a crash. Marking every queued
          // input interrupted makes the active continuation's owner ambiguous.
          const exited = { ...run, kernelExit: { code: observation.code, signal: observation.signal } };
          if (run.state === "queued") {
            this.store.put("runs", exited);
            continue;
          }
          this.store.put("runs", { ...exited, state: "interrupted" });
          this.store.updateTask(run.taskId, "interrupted");
        }
      });
    }
  }

  frame(generation: number, frame: KernelFrame): void {
    if (frame.event !== "agent" && frame.event !== "chat") return;
    const payload = frame.payload ?? {};
    if (typeof payload.runId !== "string" || typeof payload.sessionKey !== "string") return;
    this.store.transaction(() => {
      // An empty completion that never ran a turn is reported to the user but does not
      // raise a result notification: nothing was produced to announce.
      let unconfirmedResult = false;
      const identity = this.store.engineIdentity(generation, frame.event, payload);
      const run = this.store.ensureRun(payload.runId as string, payload.sessionKey as string, generation);
      if (!run) {
        this.store.retainUnassociatedFrame(identity, payload.runId as string, generation, frame);
        return;
      }
      if (!this.store.acceptEngineFrame(identity)) return;
      const task = this.store.get<Task>("tasks", run.taskId);
      if (!task) return;
      const sequence = typeof payload.seq === "number" ? payload.seq : run.lastSequence + 1;
      const visibleTerminal = frame.event === "chat" && ["final", "error", "aborted"].includes(String(payload.state));
      if (generation < run.generation) return;
      if (terminal.has(run.state)) {
        if (frame.event === "chat") {
          const widgets = nativeWidgets(payload.message, run.sessionKey);
          for (const messageId of [`engine:${run.id}`, `report:${task.id}`]) {
            const message = this.store.get<Message>("messages", messageId);
            if (message?.runId !== run.id) continue;
            const additions = widgets.filter((widget) => !message.blocks.some((block) => block.id === widget.id));
            if (additions.length) this.store.put("messages", {
              ...message, blocks: [...message.blocks, ...additions], updatedAt: Date.now(),
            });
          }
        }
        // Late facts still belong to this exact run. Update tool receipts while
        // preserving the already committed task outcome and final reply.
        if (frame.event === "agent" && payload.stream === "tool") {
          const data = object(payload.data);
          recordNativeProcess(this.store, task, run, data);
          const childRunId = recordNativeDelegation(this.store, task, run, generation, data);
          if (childRunId) this.replayPending(childRunId);
          if (data.phase === "result" && (typeof data.toolCallId === "string" || typeof data.itemId === "string")) {
            const id = `tool:${String(data.toolCallId ?? data.itemId)}`;
            for (const messageId of [`engine:${run.id}`, `report:${task.id}`]) {
              const message = this.store.get<Message>("messages", messageId);
              if (message?.runId !== run.id) continue;
              const previous = message.blocks.find((block) => block.id === id);
              if (previous?.kind !== "tool") continue;
              this.store.put("messages", {
                ...message, updatedAt: Math.max(Date.now(), message.updatedAt + 1),
                blocks: message.blocks.map((block) => block.id === id ? toolBlock(data, id, previous) : block),
              });
            }
          }
        }
        return;
      }
      if (generation === run.generation && sequence < run.lastSequence && !visibleTerminal) return;
      const current: Run = {
        ...run, generation, lastSequence: generation === run.generation ? Math.max(sequence, run.lastSequence) : sequence,
        ...(generation !== run.generation ? { kernelExit: undefined } : {}),
      };
      const messageId = `engine:${run.id}`;
      const now = Date.now();
      const message: Message = this.store.get<Message>("messages", messageId) ?? {
        id: messageId, conversationId: task.conversationId, botId: task.botId,
        role: "assistant", taskId: task.id, runId: run.id, blocks: [], final: false,
        createdAt: now, updatedAt: now,
        ...(run.clientNonce ? { clientNonce: run.clientNonce } : {}),
      };
      let changed = false;
      const data = object(payload.data);
      if (frame.event === "chat") {
        for (const widget of nativeWidgets(payload.message, run.sessionKey)) {
          if (!message.blocks.some((block) => block.id === widget.id)) {
            message.blocks.push(widget);
            changed = true;
          }
        }
      }
      if (frame.event === "agent") {
        const stream = String(payload.stream ?? "");
        if (["queued", "interrupted"].includes(current.state) &&
          (["assistant", "reasoning", "thinking", "tool"].includes(stream) ||
            (stream === "lifecycle" && data.phase === "model" && typeof data.provider === "string" && data.provider))) {
          // Recovered followups can use reply-dispatch events without a
          // lifecycle start. Native execution facts still establish activity.
          current.state = "running";
          this.store.updateTask(task.id, "running");
        }
        if (stream === "lifecycle") {
          if (data.phase === "start") {
            current.state = "running";
            this.store.updateTask(task.id, "running");
          }
          // chat final/error/aborted owns the visible terminal; a lifecycle end
          // alone can precede persistence and is not enough to claim delivery.
        } else if ((stream === "assistant" || stream === "reasoning" || stream === "thinking") &&
          (typeof data.text === "string" || typeof data.delta === "string")) {
          const kind = stream === "assistant" ? "text" : "reasoning";
          const last = message.blocks.at(-1);
          const id = typeof data.itemId === "string"
            ? `${kind}:${data.itemId}`
            : last?.kind === kind && !last.native ? last.id : `${kind}:${sequence}`;
          const existing = message.blocks.find((block) => block.id === id);
          if (existing?.kind === kind) {
            existing.text = typeof data.text === "string" ? data.text : existing.text + String(data.delta ?? "");
          } else {
            message.blocks.push({ id, kind, text: String(data.text ?? data.delta ?? "") });
          }
          changed = true;
        } else if (stream === "tool") {
          recordNativeProcess(this.store, task, run, data);
          const childRunId = recordNativeDelegation(this.store, task, run, generation, data);
          if (childRunId) this.replayPending(childRunId);
          const id = `tool:${String(data.toolCallId ?? data.itemId ?? sequence)}`;
          const existing = message.blocks.find((block) => block.id === id);
          const block = toolBlock(data, id, existing?.kind === "tool" ? existing : undefined);
          if (existing) Object.assign(existing, block);
          else message.blocks.push(block);
          changed = true;
        } else if (stream === "item" && data.kind === "tool") {
          const id = `tool:${String(data.toolCallId ?? data.itemId ?? sequence)}`;
          const existing = message.blocks.find((block) => block.id === id);
          if (typeof data.title === "string") {
            if (existing?.kind === "tool") existing.title = data.title;
            else message.blocks.push({
              id, kind: "tool", name: String(data.name ?? "tool"), title: data.title,
              phase: String(data.phase ?? "running"),
            });
            changed = true;
          }
        }
      }
      if (frame.event === "chat" && ["final", "error", "aborted"].includes(String(payload.state))) {
        const restartCancellation = payload.state === "aborted" &&
          ["restart", "gateway-restart", "shutdown"].includes(String(payload.stopReason));
        if (restartCancellation && run.state === "queued") {
          // Native shutdown also aborts the temporary owners of retained
          // queued inputs. That is custody transfer, not an interrupted turn.
          this.store.put("runs", { ...current, state: "queued" });
          return;
        }
        const status: TaskStatus = payload.state === "final" ? "completed" : payload.state === "error" ? "failed" : "cancelled";
        current.state = status;
        current.endedAt = now;
        message.final = true;
        const finalText = textContent(payload.message);
        if (isSilentReply(finalText)) message.silent = true;
        if (finalText) {
          // A streaming or restored reply ends with the same text the final frame carries,
          // so that block is updated in place. A final answer that follows reasoning or a
          // tool — or differs from the last paragraph — is its own block, never a rewrite
          // of it, and a replay updates that block instead of appending another.
          const tail = message.blocks.at(-1);
          const existingFinal = message.blocks.find((block) => block.id === "final");
          const sameReply = tail?.kind === "text" &&
            (finalText === tail.text || finalText.startsWith(tail.text));
          if (sameReply && tail.kind === "text") tail.text = finalText;
          else if (existingFinal?.kind === "text") existingFinal.text = finalText;
          else message.blocks.push({ id: "final", kind: "text", text: finalText });
        }
        const error = typeof payload.errorMessage === "string" ? payload.errorMessage : undefined;
        if (restartCancellation) {
          current.state = "interrupted";
          this.store.updateTask(task.id, "interrupted");
        } else {
          this.store.updateTask(task.id, status, error);
          // A completed frame whose run never left the queue produced no turn. A steering
          // input was folded into the active turn, which is expected; any other accepted
          // input would otherwise show as a successful empty answer.
          // Scheduled work supplies its result through the routine path, so this only
          // concerns an ordinary accepted input.
          const withoutTurn = status === "completed" && run.state === "queued" && !message.blocks.length &&
            !task.routine;
          let unconfirmed = withoutTurn;
          if (withoutTurn &&
            this.store.find<SubmissionRecord>("submissions", "taskId", task.id).some((input) => input.queueMode === "steer")) {
            this.store.put("tasks", {
              ...this.store.get<Task>("tasks", task.id)!, inputDisposition: "steered",
            });
          } else if (withoutTurn) {
            unconfirmedResult = true;
            // The input was accepted and may have reached an earlier turn, so this is an
            // unconfirmed result, not a command that never started. Nothing is resent.
            current.state = "failed";
            // The completion was recorded a moment ago, so the task is already terminal;
            // write the corrected terminal state directly instead of a guarded update.
            this.store.put("tasks", {
              ...this.store.get<Task>("tasks", task.id)!, status: "failed", error: "unconfirmed-empty-result",
              updatedAt: now,
            });
          }
          if (current.state !== "completed") message.blocks.push({
            id: "status", kind: "text",
            text: current.state === "cancelled" ? "工作已停止。"
              : unconfirmed ? "这次没有拿到结果，无法确认是否已经执行；请核对后再决定是否重发。"
              : `工作未完成。${error ? `\n\n${error}` : ""}`,
          });
          if (task.reportConversationId !== task.conversationId) {
            this.store.put<Message>("messages", {
              ...message, id: `report:${task.id}`, conversationId: task.reportConversationId, updatedAt: now,
            }, "messages.delivered");
          }
        }
        changed = true;
      }
      this.store.put("runs", current);
      if (changed) this.store.put("messages", { ...message, updatedAt: now });
      if (visibleTerminal && !unconfirmedResult && ["completed", "failed"].includes(current.state)) {
        this.store.notifyResult(task.id, run.id, task.reportConversationId === task.conversationId ? message.id : `report:${task.id}`);
      }
    });
  }

  replayPending(runId: string): void {
    this.store.transaction(() => {
      for (const pending of this.store.pendingFrames<KernelFrame>(runId)) {
        if (pending.frame.event !== "agent" && pending.frame.event !== "chat") continue;
        this.frame(pending.generation, pending.frame);
        this.store.associatePendingFrame(pending.identity);
      }
    });
  }
}
