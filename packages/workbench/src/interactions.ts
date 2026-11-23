import { createHash } from "node:crypto";
import type { GatewayRequests, KernelFrame, RuntimeObservation } from "../../kernel-runtime/src/contracts.ts";
import type { Interaction, InteractionAnswer, QuestionField, Run, Task } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";

export interface InteractionGateway extends GatewayRequests {
  generation: number;
}

export type { InteractionAnswer } from "./contracts.ts";

type ResolutionReceipt = {
  id: string; interactionId: string; digest: string; state: "pending" | "confirmed";
};
const open = new Set<Interaction["status"]>(["pending", "answering"]);
const terminalTask = new Set(["completed", "failed", "cancelled", "interrupted"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Native human-input ownership; no model turn is started by answering here. */
export class Interactions {
  private readonly store: WorkbenchStore;
  private readonly gateway: InteractionGateway;
  private readonly resolving = new Map<string, Promise<Interaction>>();

  constructor(store: WorkbenchStore, gateway: InteractionGateway) {
    this.store = store;
    this.gateway = gateway;
  }

  observe(observation: RuntimeObservation): void {
    if (observation.type === "frame") this.frame(observation.frame, observation.generation);
    if (observation.type === "exit") {
      for (const prompt of this.store.list<Interaction>("interactions")) {
        if (prompt.generation === observation.generation && open.has(prompt.status)) {
          this.store.put("interactions", { ...prompt, status: "unavailable" });
        }
      }
    }
  }

  frame(frame: KernelFrame, generation: number): void {
    const kind = frame.event.startsWith("question.") ? "question" :
      frame.event.startsWith("exec.approval.") ? "approval" : undefined;
    if (!kind) return;
    const payload = frame.payload ?? {};
    const engineId = text(payload.id);
    if (!engineId) return;
    const id = `${kind}:${engineId}`;
    if (frame.event.endsWith(".resolved")) {
      const existing = this.store.get<Interaction>("interactions", id);
      if (!existing || existing.generation !== generation || !open.has(existing.status)) return;
      const state = text(payload.status);
      const status: Interaction["status"] = state === "cancelled" ? "cancelled" :
        state === "expired" || (kind === "approval" && payload.decision == null) ? "expired" : "answered";
      this.store.transaction(() => {
        this.store.put("interactions", { ...existing, status, answer: this.answerSummary(existing, payload) });
        this.resumeIfClear(existing.taskId);
      });
      return;
    }
    if (!frame.event.endsWith(".requested")) return;
    const request = kind === "approval" ? object(payload.request) : payload;
    const sessionKey = text(request.sessionKey);
    const runId = text(request.runId);
    if (!sessionKey || !runId) return; // Never guess among active/queued tasks.
    const run = this.store.get<Run>("runs", runId) ?? this.store.ensureRun(runId, sessionKey, generation);
    if (!run) {
      this.store.retainUnassociatedFrame(this.store.engineIdentity(generation, frame.event, payload), runId, generation, frame);
      return;
    }
    if (run.sessionKey !== sessionKey || terminalTask.has(run.state)) return;
    const existing = this.store.get<Interaction>("interactions", id);
    if (existing && (!open.has(existing.status) || existing.generation > generation)) return;
    const questions: QuestionField[] = [];
    if (kind === "question") {
      if (!Array.isArray(payload.questions) || payload.questions.length < 1 || payload.questions.length > 3) return;
      // Secret values belong in the native masked credential flow, not in
      // ordinary persistent conversation records or event payloads.
      if (payload.questions.some((value) => object(value).isSecret || object(value).secretStore)) {
        this.store.recordEvent("interaction.secure-input-required", run.taskId, { id, taskId: run.taskId });
        return;
      }
      for (const value of payload.questions) {
        const field = object(value);
        if (!text(field.questionId) || !text(field.question)) return;
        questions.push({
          id: text(field.questionId), header: text(field.header), question: text(field.question),
          multiSelect: field.multiSelect === true, allowOther: field.isOther === true,
          options: (Array.isArray(field.options) ? field.options : []).map((option) => {
            const entry = object(option);
            return { label: text(entry.label), value: text(entry.value, text(entry.label)),
              ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
          }),
        });
      }
    }
    const decisions = (Array.isArray(request.allowedDecisions) ? request.allowedDecisions : ["allow-once", "deny"])
      .filter((decision): decision is Interaction["decisions"][number] =>
        decision === "allow-once" || decision === "allow-always" || decision === "deny");
    // Native display analysis is descriptive only. Never copy env, authority
    // bindings or arbitrary request fields into the persisted UI projection.
    const analysis = object(request.commandAnalysis);
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    const count = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const approval: Interaction["approval"] = kind === "approval" ? {
      ...(typeof request.command === "string" ? { command: request.command } : {}),
      ...(typeof request.host === "string" ? { host: request.host } : {}),
      ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
      ...(typeof request.warningText === "string" ? { warningText: request.warningText } : {}),
      ...(request.commandAnalysis && typeof request.commandAnalysis === "object" && !Array.isArray(request.commandAnalysis) ? {
        commandAnalysis: {
          commandCount: count(analysis.commandCount),
          nestedCommandCount: count(analysis.nestedCommandCount),
          riskKinds: strings(analysis.riskKinds),
          warningLines: strings(analysis.warningLines),
        },
      } : {}),
    } : undefined;
    this.store.transaction(() => {
      const task = this.store.get<Task>("tasks", run.taskId);
      if (!task || terminalTask.has(task.status)) return;
      this.store.put<Interaction>("interactions", {
        id, engineId, kind, runId, sessionKey, taskId: task.id, conversationId: task.conversationId,
        generation, title: kind === "question" ? questions[0]!.question : text(request.commandPreview,
          text(request.command, "执行操作")),
        ...(approval ? { approval: { ...approval, taskTitle: task.title } } : {}),
        questions, decisions: kind === "approval" ? decisions : [],
        status: existing?.status ?? "pending",
        createdAt: Number(payload.createdAtMs) || Date.now(),
        expiresAt: Number(payload.expiresAtMs) || Date.now(),
      });
      this.store.updateTask(task.id, "waiting");
      this.store.put("runs", { ...run, state: "waiting" });
    });
  }

  replayPending(runId: string): void {
    for (const pending of this.store.pendingFrames<KernelFrame>(runId)) {
      this.frame(pending.frame, pending.generation);
      if (pending.frame.event.startsWith("question.") || pending.frame.event.startsWith("exec.approval.")) {
        this.store.associatePendingFrame(pending.identity);
      }
    }
  }

  async recover(): Promise<void> {
    // Each read is triggered by handshake/gap recovery, never a periodic loop.
    const generation = this.gateway.generation;
    const observed = this.store.list<Interaction>("interactions").filter((prompt) => open.has(prompt.status));
    const [questions, approvals] = await Promise.all([
      this.gateway.request<{ questions: Record<string, unknown>[] }>("question.list", {}),
      this.gateway.request<Record<string, unknown>[]>("exec.approval.list", {}),
    ]);
    if (this.gateway.generation !== generation) return;
    for (const question of questions.questions) this.frame({ event: "question.requested", payload: question }, generation);
    for (const approval of approvals) this.frame({ event: "exec.approval.requested", payload: approval }, generation);
    const pending = new Set([...questions.questions.map((record) => `question:${text(record.id)}`),
      ...approvals.map((record) => `approval:${text(record.id)}`)]);
    for (const previous of observed) {
      const prompt = this.store.get<Interaction>("interactions", previous.id)!;
      if (open.has(prompt.status) && !pending.has(prompt.id)) {
        if (prompt.kind === "question" && prompt.generation === generation) {
          try {
            const result = await this.gateway.request<Record<string, unknown>>("question.waitAnswer", {
              id: prompt.engineId, timeoutMs: 1, includeResolutionId: true,
            });
            if (this.gateway.generation !== generation) return;
            if (["answered", "cancelled", "expired"].includes(text(result.status))) {
              this.frame({ event: "question.resolved", payload: { ...result, id: prompt.engineId } }, generation);
              continue;
            }
          } catch { /* Native terminal receipts have a bounded retention period. */ }
        }
        if (this.gateway.generation === generation && open.has(this.store.get<Interaction>("interactions", prompt.id)!.status)) {
          this.store.put("interactions", { ...prompt, status: "unavailable" });
        }
      }
    }
  }

  resolve(id: string, taskId: string, answer: InteractionAnswer): Promise<Interaction> {
    const prompt = this.store.get<Interaction>("interactions", id);
    if (!prompt || prompt.taskId !== taskId) return Promise.reject(new Error("Interaction does not belong to this task"));
    const digest = createHash("sha256").update(JSON.stringify(answer)).digest("hex");
    const receiptId = `interaction-answer:${answer.resolutionId}`;
    const receipt = this.store.get<ResolutionReceipt>("settings", receiptId);
    if (receipt && (receipt.digest !== digest || receipt.interactionId !== id)) return Promise.reject(new Error("Answer identity conflicts"));
    if (this.store.list<ResolutionReceipt>("settings").some((candidate) =>
      candidate.interactionId === id && candidate.state === "pending" && candidate.id !== receiptId)) {
      return Promise.reject(new Error("An earlier answer is awaiting confirmation"));
    }
    if (receipt?.state === "confirmed") return Promise.resolve(prompt);
    if (!open.has(prompt.status) || prompt.generation !== this.gateway.generation) return Promise.reject(new Error("Interaction is no longer available"));
    if (prompt.expiresAt <= Date.now()) return Promise.reject(new Error("Interaction has expired"));
    const task = this.store.get<Task>("tasks", taskId);
    if (!task || terminalTask.has(task.status) || task.status === "stopping") return Promise.reject(new Error("Task is no longer awaiting an answer"));
    const inProgress = this.resolving.get(id);
    if (inProgress) {
      if (!receipt || receipt.digest !== digest) return Promise.reject(new Error("Another answer is being submitted"));
      return inProgress;
    }
    if (!answer.resolutionId || answer.resolutionId.length > 128) return Promise.reject(new Error("Invalid answer identity"));
    const params = this.parameters(prompt, answer);
    this.store.transaction(() => {
      this.store.put<ResolutionReceipt>("settings", { id: receiptId, interactionId: id, digest, state: "pending" }, "interaction.answer-pending");
      this.store.put("interactions", { ...prompt, status: "answering" });
    });
    const operation = this.submitAnswer(prompt, params, receiptId, digest).finally(() => this.resolving.delete(id));
    this.resolving.set(id, operation);
    return operation;
  }

  private parameters(prompt: Interaction, answer: InteractionAnswer): Record<string, unknown> {
    if (prompt.kind === "approval") {
      if (!("decision" in answer) || !prompt.decisions.includes(answer.decision)) throw new Error("Decision is not available");
      return { id: prompt.engineId, decision: answer.decision };
    }
    if ("cancel" in answer) return { id: prompt.engineId, cancel: true };
    if (!("answers" in answer) || Object.keys(answer.answers).some((id) => !prompt.questions.some((field) => field.id === id))) {
      throw new Error("Unexpected question answer");
    }
    for (const field of prompt.questions) {
      const values = answer.answers[field.id];
      if (!Array.isArray(values) || values.length < 1 || (!field.multiSelect && values.length !== 1) ||
        values.some((value) => typeof value !== "string" || !value.trim() || value.length > 4096 ||
          (!field.allowOther && !field.options.some((option) => option.value === value)))) {
        throw new Error("Invalid question answer");
      }
    }
    return { id: prompt.engineId, answers: { answers: answer.answers }, resolutionId: answer.resolutionId };
  }

  private async submitAnswer(prompt: Interaction, params: Record<string, unknown>, receiptId: string, digest: string): Promise<Interaction> {
    try {
      let result: Record<string, unknown>;
      try {
        result = object(await this.gateway.request(prompt.kind === "question" ? "question.resolve" : "exec.approval.resolve", params));
      } catch (error) {
        if (prompt.kind !== "question") throw error;
        const receipt = await this.gateway.request<Record<string, unknown>>("question.waitAnswer", {
          id: prompt.engineId, timeoutMs: 1, includeResolutionId: true,
        }).catch(() => undefined);
        if (receipt?.status !== "answered" || receipt.resolutionId !== params.resolutionId) throw error;
        result = receipt;
      }
      return this.store.transaction(() => {
        this.store.put<ResolutionReceipt>("settings", { id: receiptId, interactionId: prompt.id, digest, state: "confirmed" }, "interaction.answer-confirmed");
        const current = this.store.get<Interaction>("interactions", prompt.id)!;
        this.store.put("interactions", {
          ...current,
          status: open.has(current.status) ? params.cancel === true ? "cancelled" : "answered" : current.status,
          answer: this.answerSummary(prompt, { ...params, ...result }) ?? current.answer,
        });
        this.resumeIfClear(prompt.taskId);
        return this.store.get<Interaction>("interactions", prompt.id)!;
      });
    } catch (error) {
      // Keep the pending identity. A lost acknowledgment is not a denial and
      // does not authorize a different answer on an uncertain operation.
      throw error;
    }
  }

  private answerSummary(prompt: Interaction, result: Record<string, unknown>): Interaction["answer"] {
    if (prompt.kind === "approval") {
      const decision = result.decision;
      return decision === "allow-once" || decision === "allow-always" || decision === "deny" ? { decision } : undefined;
    }
    const values = object(object(result.answers).answers);
    const answers: Record<string, string[]> = {};
    for (const field of prompt.questions) {
      const value = values[field.id];
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) answers[field.id] = value;
    }
    return Object.keys(answers).length ? { answers } : undefined;
  }

  private resumeIfClear(taskId: string): void {
    const task = this.store.get<Task>("tasks", taskId);
    if (task?.status !== "waiting") return;
    if (this.store.list<Interaction>("interactions").some((item) => item.taskId === taskId && open.has(item.status))) return;
    this.store.updateTask(taskId, "running");
    for (const run of this.store.list<Run>("runs")) if (run.taskId === taskId && run.state === "waiting") {
      this.store.put("runs", { ...run, state: "running" });
    }
  }
}
