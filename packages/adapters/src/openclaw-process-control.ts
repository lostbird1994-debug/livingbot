import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
interface Owner {
  sessionKey: string;
  runId: string;
  pid?: number;
  observedAt: number;
}

/**
 * The public Gateway cannot invoke the process tool. Keep this small host ABI
 * boundary version-pinned and fail closed on upgrades. It runs inside the engine;
 * importing its registry from the LivingBot process would create a different registry.
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

/** A PID that no longer exists is terminated, even when the engine lost its registry. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Only trusted engine tool events can establish ownership; RPC arguments cannot. */
export class NativeProcessControl {
  private owners = new Map<string, Owner>();
  /**
   * @param ledger optional durable file. The engine's own registry lives in memory, so a
   * restart forgets every background command it started. Persisting the handle identity
   * (session, run, PID) is what lets a later poll answer truthfully instead of failing
   * closed forever on a command that already exited with its engine.
   */
  constructor(
    private backend: () => Promise<NativeProcessBackend> = loadNativeProcessBackend,
    private ledger?: string,
  ) {
    this.restore();
  }

  private restore() {
    if (!this.ledger) return;
    try {
      const rows = JSON.parse(readFileSync(this.ledger, "utf8")) as Record<string, Owner>;
      for (const [id, owner] of Object.entries(rows)) {
        if (!owner || typeof owner.sessionKey !== "string" || typeof owner.runId !== "string") continue;
        if (Date.now() - owner.observedAt <= 24 * 60 * 60_000) this.owners.set(id, owner);
      }
    } catch { /* A missing or unreadable ledger only loses restart recovery. */ }
  }

  private persist() {
    if (!this.ledger) return;
    try {
      mkdirSync(dirname(this.ledger), { recursive: true, mode: 0o700 });
      const file = `${this.ledger}.tmp`;
      writeFileSync(file, JSON.stringify(Object.fromEntries(this.owners)), { mode: 0o600 });
      renameSync(file, this.ledger);
    } catch { /* Ownership stays in memory; a write failure never grants access. */ }
  }

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
    let pruned = false;
    for (const [id, owner] of this.owners)
      if (Date.now() - owner.observedAt > 24 * 60 * 60_000) {
        this.owners.delete(id);
        pruned = true;
      }
    this.owners.set(details.sessionId, { sessionKey, runId, pid: details.pid, observedAt: Date.now() });
    if (pruned || this.ledger) this.persist();
  }

  async control(params: Record<string, unknown>) {
    const { sessionKey, runId, sessionId, action } = params;
    let owner = typeof sessionId === "string" ? this.owners.get(sessionId) : undefined;
    if (!owner && typeof sessionId === "string") {
      // A restarted engine starts with an empty map; the ledger is the only memory left.
      this.restore();
      owner = this.owners.get(sessionId);
    }
    if (
      !owner || owner.sessionKey !== sessionKey || owner.runId !== runId ||
      (action !== "kill" && action !== "poll")
    ) throw new Error("Native process ownership is not confirmed");
    const backend = await this.backend();
    const running = backend.getSession(sessionId as string);
    const finished = backend.getFinishedSession(sessionId as string);
    const entry = running ?? finished;
    if (!entry) {
      // The registry that started this command is gone (engine restart). The persisted
      // PID is the remaining evidence: alive means still running, gone means terminated.
      if (owner.pid === undefined) throw new Error("Native process scope is not confirmed");
      if (isProcessAlive(owner.pid)) return { status: "running" };
      return { status: "failed" };
    }
    if (
      entry.scopeKey !== sessionKey ||
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
