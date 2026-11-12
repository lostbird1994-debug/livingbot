import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface ProcessEntry {
  scopeKey?: string;
  pid?: number;
  backgrounded?: boolean;
  exited?: boolean;
  terminalStatus?: string;
}
export interface NativeProcessBackend {
  getSession(id: string): ProcessEntry | undefined;
  getFinishedSession(id: string): ProcessEntry | undefined;
  cancel(id: string): boolean;
}

/**
 * The public Gateway cannot invoke the process tool. Keep this small host ABI
 * boundary version-pinned and fail closed on upgrades. It runs inside the engine;
 * importing its registry from the Rakazo process would create a different registry.
 */
export async function loadNativeProcessBackend(): Promise<NativeProcessBackend> {
  const hostEntry = process.argv[1];
  if (!hostEntry) throw new Error("OpenClaw process host entry is unavailable");
  const hostRequire = createRequire(hostEntry);
  const packageFile = join(dirname(dirname(hostRequire.resolve("openclaw"))), "package.json");
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  if (pkg.name !== "openclaw" || pkg.version !== "2026.5.7")
    throw new Error("Native process control requires a verified OpenClaw host version");
  const dist = join(dirname(packageFile), "dist");
  const [registry, control] = await Promise.all([
      import(pathToFileURL(join(dist, "bash-tools.exec-runtime-_AZK38Oh.js")).href),
      import(pathToFileURL(join(dist, "supervisor-BtDF8VrN.js")).href),
  ]);
  if (
    typeof registry.y !== "function" ||
    typeof registry.v !== "function" ||
    typeof control.t !== "function"
  ) throw new Error("OpenClaw process ABI is unavailable");
  return {
    getSession: registry.y,
    getFinishedSession: registry.v,
    cancel(id) {
      const supervisor = control.t();
      const record = supervisor.getRecord(id);
      if (!record || record.state === "exited") return false;
      supervisor.cancel(id, "manual-cancel");
      return true;
    },
  };
}

/** Only trusted engine tool events can establish ownership; RPC arguments cannot. */
export class NativeProcessControl {
  private owners = new Map<string, {
    sessionKey: string; runId: string; pid?: number; observedAt: number;
  }>();
  constructor(private backend: () => Promise<NativeProcessBackend> = loadNativeProcessBackend) {}

  observe(
    event: { toolName: string; runId?: string; result?: any },
    context: { sessionKey?: string; runId?: string },
  ) {
    const sessionKey = context.sessionKey;
    const runId = context.runId ?? event.runId;
    const details = event.result?.details;
    if (
      event.toolName !== "exec" ||
      !sessionKey || !/^agent:[a-zA-Z0-9_-]+:rakazo:[a-f0-9]{64}$/.test(sessionKey) ||
      !runId || !/^rakazo-[a-f0-9]{64}$/.test(runId) ||
      details?.status !== "running" ||
      typeof details.sessionId !== "string"
    ) return;
    // Retain enough time for the maximum native run plus cancellation/reconnect.
    for (const [id, owner] of this.owners)
      if (Date.now() - owner.observedAt > 24 * 60 * 60_000) this.owners.delete(id);
    this.owners.set(details.sessionId, { sessionKey, runId, pid: details.pid, observedAt: Date.now() });
  }

  async control(params: Record<string, unknown>) {
    const { sessionKey, runId, sessionId, action } = params;
    const owner = typeof sessionId === "string" ? this.owners.get(sessionId) : undefined;
    if (
      !owner || owner.sessionKey !== sessionKey || owner.runId !== runId ||
      (action !== "kill" && action !== "poll")
    ) throw new Error("Native process ownership is not confirmed");
    const backend = await this.backend();
    const running = backend.getSession(sessionId as string);
    const finished = backend.getFinishedSession(sessionId as string);
    const entry = running ?? finished;
    if (
      !entry || entry.scopeKey !== sessionKey ||
      (owner.pid !== undefined && entry.pid !== undefined && owner.pid !== entry.pid)
    ) throw new Error("Native process scope is not confirmed");
    if (finished || running?.exited)
      return { status: entry.terminalStatus === "completed" ? "completed" : "failed" };
    if (!running?.backgrounded) throw new Error("Native process is not backgrounded");
    if (action === "kill" && !backend.cancel(sessionId as string))
      throw new Error("Native process has no live cancellation handle");
    // A cancellation request is not evidence that the process has exited.
    return { status: "running" };
  }
}
