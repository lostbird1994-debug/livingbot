import { createHash, randomBytes } from "node:crypto";

// The catalog is deliberately restricted. Execution still goes through the run's gate.
export const NATIVE_COLLABORATION_TOOLS = [
  "message_bot",
  "handoff_to_bot",
  "list_fleet",
  "connect_agent",
  "respond_agent_connection",
  "message_agent",
] as const;

export interface CollaborationTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface CollaborationCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
type PendingCall = CollaborationCall & {
  fingerprint: string;
  result?: unknown;
  done: boolean;
  cancelled?: boolean;
  resolve(value: unknown): void;
  promise: Promise<unknown>;
};
type Registration = {
  sessionKey: string;
  runId: string;
  tools: CollaborationTool[];
  clientToken: string;
  expiresAt: number;
  calls: Map<string, PendingCall>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const failed = (error: string) => ({ error });

/** Only the authenticated native control connection may register, poll or resolve calls. */
export class NativeCollaborationBroker {
  private registrations = new Map<string, Registration>();
  constructor(private now: () => number = Date.now) {}

  private active(sessionKey: unknown, runId?: unknown) {
    const record = typeof sessionKey === "string" ? this.registrations.get(sessionKey) : undefined;
    if (!record || (runId !== undefined && record.runId !== runId))
      throw new Error("No active Rakazo collaboration grant");
    if (record.expiresAt <= this.now()) {
      this.close({ sessionKey: record.sessionKey, runId: record.runId });
      throw new Error("Rakazo collaboration grant expired");
    }
    return record;
  }

  register(params: Record<string, unknown>) {
    const { sessionKey, runId, tools } = params;
    if (
      typeof sessionKey !== "string" ||
      !/^agent:[a-zA-Z0-9_-]+:rakazo:[a-f0-9]{64}$/.test(sessionKey) ||
      typeof runId !== "string" ||
      !/^rakazo-[a-f0-9]{64}$/.test(runId) ||
      !Array.isArray(tools) ||
      tools.length > NATIVE_COLLABORATION_TOOLS.length ||
      JSON.stringify(tools).length > 128_000 ||
      tools.some(
        (tool) =>
          !object(tool) ||
          !NATIVE_COLLABORATION_TOOLS.includes(tool.name as never) ||
          typeof tool.description !== "string" ||
          !object(tool.inputSchema),
      ) ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length
    )
      throw new Error("Invalid Rakazo collaboration registration");
    let prior = this.registrations.get(sessionKey);
    if (prior && prior.expiresAt <= this.now()) {
      this.close({ sessionKey, runId: prior.runId });
      prior = undefined;
    }
    if (prior && (prior.runId !== runId || digest(prior.tools) !== digest(tools)))
      throw new Error("An active collaboration grant cannot change identity or tools");
    const record: Registration = prior ?? {
      sessionKey,
      runId,
      tools: structuredClone(tools),
      clientToken: randomBytes(32).toString("hex"),
      expiresAt: 0,
      calls: new Map(),
    };
    record.expiresAt = this.now() + 30 * 60_000;
    this.registrations.set(sessionKey, record);
    return { clientToken: record.clientToken };
  }

  tools(sessionKey: string, runId?: string) {
    try {
      const record = this.active(sessionKey, runId);
      return { runId: record.runId, tools: structuredClone(record.tools) };
    } catch {
      return { runId: "", tools: [] };
    }
  }

  /** sessionKey/runId come from the trusted native context, never model tool arguments. */
  async call(sessionKey: string, runId: string, call: CollaborationCall) {
    const record = this.active(sessionKey, runId);
    if (
      typeof call.id !== "string" ||
      !call.id ||
      call.id.length > 512 ||
      !record.tools.some((tool) => tool.name === call.name) ||
      !object(call.args) ||
      JSON.stringify(call.args).length > 128_000
    )
      throw new Error("Invalid collaboration tool call");
    const fingerprint = digest([call.name, call.args]);
    let pending = record.calls.get(call.id);
    if (pending && pending.fingerprint !== fingerprint)
      throw new Error("Collaboration call identity changed");
    if (!pending) {
      if (record.calls.size >= 128) throw new Error("Collaboration call limit exceeded");
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((done) => {
        resolve = done;
      });
      pending = { ...structuredClone(call), fingerprint, done: false, promise, resolve };
      record.calls.set(call.id, pending);
    }
    // Expiry also releases a pending native tool if its worker never reconnects.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.promise,
        new Promise((resolve) => {
          timer = setTimeout(
            () => {
              if (this.registrations.get(sessionKey) === record) this.close({ sessionKey, runId });
              resolve(failed("Rakazo collaboration grant expired"));
            },
            Math.max(1, record.expiresAt - this.now()),
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  client(params: Record<string, unknown>) {
    const record = this.active(params.sessionKey, params.runId);
    if (typeof params.clientToken !== "string" || params.clientToken !== record.clientToken)
      throw new Error("Invalid collaboration client");
    return record;
  }

  poll(params: Record<string, unknown>) {
    const record = this.active(params.sessionKey, params.runId);
    return {
      calls: [...record.calls.values()]
        .filter((call) => !call.done)
        .map(({ id, name, args }) => ({ id, name, args })),
    };
  }

  resolve(params: Record<string, unknown>) {
    const record = this.active(params.sessionKey, params.runId);
    const call = record.calls.get(String(params.id));
    if (!call) throw new Error("Unknown collaboration call");
    if (call.cancelled) return { ok: true };
    if (call.done && digest(call.result) !== digest(params.result))
      throw new Error("Collaboration result identity changed");
    call.done = true;
    call.result = params.result;
    call.resolve(params.result);
    return { ok: true };
  }

  cancel(sessionKey: string, runId: string, id: string) {
    const record = this.active(sessionKey, runId);
    const call = record.calls.get(id);
    if (call && !call.done) {
      call.done = true;
      call.cancelled = true;
      call.result = failed("Native collaboration tool call cancelled");
      call.resolve(call.result);
    }
    return { ok: true };
  }

  close(params: Record<string, unknown>) {
    const record =
      typeof params.sessionKey === "string" ? this.registrations.get(params.sessionKey) : undefined;
    if (record && record.runId === params.runId) {
      for (const call of record.calls.values())
        if (!call.done) call.resolve(failed("Rakazo collaboration run closed"));
      this.registrations.delete(record.sessionKey);
    }
    return { ok: true };
  }
}
