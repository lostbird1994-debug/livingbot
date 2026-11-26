import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type {
  Acceptance, GatewayPeer, HistoryPage, KernelFrame, PeerFactory, ProcessPage,
  RuntimeObservation, RuntimePhase, Submission,
} from "./contracts.ts";
import type { RuntimePaths } from "./paths.ts";
import { runtimeEnvironment } from "./paths.ts";
import { validateAgentId } from "./config.ts";

export type RuntimeOptions = {
  nodeExecutable: string;
  entry: string;
  paths: RuntimePaths;
  port: number;
  token: string;
  peerFactory: PeerFactory;
  expectedVersion?: string;
  startupTimeoutMs?: number;
  initialGeneration?: number;
};

type RpcFailure = Error & { code?: string; retryable?: boolean; retryAfterMs?: number };

export class KernelRuntime extends EventEmitter {
  readonly options: RuntimeOptions;
  phase: RuntimePhase = "stopped";
  generation = 0;
  private child?: ChildProcess;
  private peer?: GatewayPeer;
  private lastSequence?: number;
  private closing = false;
  private starting?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryAttempts = 0;
  maintenance = false;
  private maintenanceEpoch = 0;

  /** The supervised Gateway PID, never authority over an agent's exec tools. */
  get processId(): number | undefined {
    return this.child?.exitCode === null && this.child.signalCode === null ? this.child.pid : undefined;
  }

  constructor(options: RuntimeOptions) {
    super();
    this.options = options;
    if (options.initialGeneration !== undefined && (!Number.isSafeInteger(options.initialGeneration) || options.initialGeneration < 0)) {
      throw new Error("Invalid kernel generation");
    }
    this.generation = options.initialGeneration ?? 0;
  }

  private observe(observation: RuntimeObservation): void {
    this.emit("observation", observation);
  }

  private transition(phase: RuntimePhase, detail?: string): void {
    this.phase = phase;
    this.observe({ type: "phase", phase, detail, generation: this.generation });
  }

  start(): Promise<void> {
    if (this.maintenance) return Promise.reject(new Error("Kernel memory maintenance is in progress"));
    return this.startAvailable();
  }

  private startAvailable(): Promise<void> {
    if (this.phase === "ready") return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.startOwned().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startOwned(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      throw new Error("The previous kernel process has not exited");
    }
    this.closing = false;
    this.generation++;
    this.lastSequence = undefined;
    const generation = this.generation;
    let readyAt: number | undefined;
    let lastConnectionError: string | undefined;
    this.transition("starting");
    const output = createWriteStream(join(this.options.paths.logs, `kernel-${generation}-${Date.now()}.log`), {
      flags: "a", mode: 0o600,
    });
    const child = spawn(this.options.nodeExecutable, [
      this.options.entry, "gateway", "--port", String(this.options.port),
    ], {
      cwd: this.options.paths.root,
      env: runtimeEnvironment(this.options.paths),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.pipe(output, { end: false });
    child.stderr?.pipe(output, { end: false });
    const processEnded = new Promise<never>((_, reject) => {
      child.once("error", (error) => { output.end(); reject(error); });
      child.once("exit", (code, signal) => {
        output.end();
        this.observe({ type: "exit", code, signal, generation });
        this.transition(this.closing ? "stopped" : "failed", this.closing ? undefined : `Kernel exited (${code ?? signal})`);
        if (!this.closing && readyAt !== undefined) {
          if (Date.now() - readyAt >= 30_000) this.recoveryAttempts = 0;
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.recoveryAttempts++, 5));
          this.transition("recovering");
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            if (this.closing || generation !== this.generation) return;
            void this.recoverExitedProcess(generation).catch((error: unknown) => {
              this.emit("diagnostic", { kind: "restart", message: String(error), generation: this.generation });
            });
          }, delay);
        }
        reject(new Error(`Kernel exited before readiness (${code ?? signal})`));
      });
    });
    // The rejection remains observed after readiness, while exit events own later recovery.
    void processEnded.catch(() => {});
    try {
      this.transition("connecting");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let credentialRetry: ReturnType<typeof setTimeout> | undefined;
      let startupPending = true;
      let peerAttempt = 0;
      const ready = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Kernel startup deadline exceeded${lastConnectionError ? `: ${lastConnectionError}` : ""}`)),
          this.options.startupTimeoutMs ?? 90_000);
        const connect = () => {
          const attempt = ++peerAttempt;
          const current = () => generation === this.generation && attempt === peerAttempt && !this.closing;
          void this.options.peerFactory({
            url: `ws://127.0.0.1:${this.options.port}`,
            token: this.options.token,
            env: runtimeEnvironment(this.options.paths),
            onEvent: (frame) => {
              if (!current()) return;
              this.acceptFrame(frame);
            },
            onHelloOk: (hello) => {
              if (!current()) return;
              const actual = hello.server?.version;
              if (this.options.expectedVersion && actual && actual !== this.options.expectedVersion) {
                reject(new Error(`Unexpected kernel version: ${actual}`));
                return;
              }
              this.lastSequence = undefined;
              // Every successful reconnect must restore the formal subscriptions,
              // including reconnects that keep the same child generation.
              void this.request("sessions.subscribe", {}).then(() => {
                if (!current()) return;
                clearTimeout(credentialRetry);
                readyAt ??= Date.now();
                this.transition("ready");
                this.observe({ type: "ready", hello, generation });
                resolve();
              }).catch((error: unknown) => {
                this.transition("recovering");
                reject(error);
                this.emit("diagnostic", { kind: "subscription", message: String(error), generation });
              });
            },
            onClose: (code, reason) => {
              if (!current()) return;
              this.transition("recovering");
              this.observe({ type: "disconnected", code, reason, generation });
            },
            onConnectError: (error) => {
              if (current()) {
                lastConnectionError = error.message;
                this.emit("diagnostic", { kind: "connection", message: error.message, generation });
                // The native client stops permanently if its credential read races
                // Gateway preparation. Recreate only that client, under the original
                // startup deadline; native admission remains responsible for repair.
                if (startupPending && readyAt === undefined && !credentialRetry &&
                  (error as Error & { code?: string }).code === "gateway.maintenance_required" &&
                  (error as Error & { kind?: string }).kind === "state-migrations") {
                  credentialRetry = setTimeout(() => {
                    credentialRetry = undefined;
                    if (!startupPending || !current() || readyAt !== undefined) return;
                    ++peerAttempt;
                    const previous = this.peer;
                    this.peer = undefined;
                    void previous?.stopAndWait().then(() => {
                      if (startupPending && !this.closing && generation === this.generation) connect();
                    }).catch(reject);
                  }, 500);
                }
              }
            },
          }).then((peer) => {
            if (!current() || !startupPending) return peer.stopAndWait();
            this.peer = peer;
            peer.start();
          }).catch(reject);
        };
        connect();
      });
      try {
        await Promise.race([ready, processEnded]);
      } finally {
        clearTimeout(timer);
        clearTimeout(credentialRetry);
        startupPending = false;
      }
    } catch (error) {
      await this.stop().catch(() => {});
      this.transition("failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async recoverExitedProcess(generation: number): Promise<void> {
    const peer = this.peer;
    this.peer = undefined;
    await peer?.stopAndWait();
    if (this.closing || generation !== this.generation) return;
    await this.start();
  }

  private acceptFrame(frame: KernelFrame): void {
    if (frame.seq !== undefined) {
      if (this.lastSequence !== undefined && frame.seq > this.lastSequence + 1) {
        this.observe({ type: "gap", expected: this.lastSequence + 1, actual: frame.seq, generation: this.generation });
      }
      this.lastSequence = Math.max(this.lastSequence ?? frame.seq, frame.seq);
    }
    if (frame.event === "shutdown" && !this.closing) this.transition("recovering");
    this.observe({ type: "frame", frame, generation: this.generation });
  }

  async request<T = unknown>(method: string, params: unknown, options: number | { timeoutMs?: number } = 30_000): Promise<T> {
    const timeoutMs = typeof options === "number" ? options : options.timeoutMs ?? 30_000;
    if (!this.peer || this.closing) throw new Error("Kernel is not connected");
    return this.peer.request<T>(method, params, { timeoutMs });
  }

  /** A bounded repair read after an explicit recovery trigger; never a run-status loop. */
  async recoverHistory(sessionKey: string, cursor?: string, inputRunIds?: string[]): Promise<HistoryPage> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        return await this.request<HistoryPage>("chat.history", {
          sessionKey, ...(cursor ? { cursor } : {}), ...(inputRunIds?.length ? { inputRunIds } : {}),
        });
      } catch (error) {
        const failure = error as RpcFailure;
        if (failure.code !== "UNAVAILABLE" || failure.retryable !== true || Date.now() >= deadline) throw error;
        const wait = Math.min(2000, Math.max(100, failure.retryAfterMs ?? 250), deadline - Date.now());
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  async send(submission: Submission): Promise<Acceptance> {
    if (this.maintenance) throw new Error("Kernel memory maintenance is in progress");
    const { sessionOwner, ...turn } = submission;
    if (sessionOwner?.kind === "private") {
      validateAgentId(sessionOwner.agentId);
      await this.request("sessions.create", {
        agentId: sessionOwner.agentId, key: submission.sessionKey,
        idempotencyKey: `livingbot-session:${submission.sessionKey}`,
      });
    }
    return this.request<Acceptance>("chat.send", turn, 40_000);
  }

  abort(sessionKey: string, runId?: string): Promise<{ ok: boolean; aborted: boolean; runIds: string[] }> {
    return this.request("chat.abort", { sessionKey, ...(runId ? { runId } : {}) });
  }

  processes(sessionKey: string): Promise<ProcessPage> {
    return this.request("sessions.processes.list", { key: sessionKey });
  }

  stopProcess(sessionKey: string, sessionId: string, processId: string, instanceId: string): Promise<{ requested: boolean }> {
    return this.request("sessions.processes.stop", { key: sessionKey, sessionId, processId, instanceId });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    ++this.maintenanceEpoch;
    await this.stopOwned();
  }

  /** Explicit operator maintenance only; callers must check product work first. */
  async offlineMaintenance<T>(operation: () => Promise<T>, options?: { restartAfter?: () => boolean }): Promise<T> {
    if (this.maintenance || this.phase !== "ready") throw new Error("Kernel is not available for memory maintenance");
    this.maintenance = true;
    const epoch = ++this.maintenanceEpoch;
    let stopped = false;
    try {
      const sessions = await this.request<{ sessions: { hasActiveRun?: boolean }[] }>("sessions.list", {});
      if (!Array.isArray(sessions.sessions) || sessions.sessions.some((session) => session.hasActiveRun !== false)) {
        throw new Error("Wait for native work to finish before memory maintenance");
      }
      await this.stopOwned();
      stopped = true;
      return await operation();
    } finally {
      try {
        // An explicit concurrent application shutdown takes precedence.
        if (stopped && epoch === this.maintenanceEpoch && (options?.restartAfter?.() ?? true)) await this.startAvailable();
      } finally { this.maintenance = false; }
    }
  }

  private async stopOwned(): Promise<void> {
    this.closing = true;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.transition("stopping");
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Kernel cleanup deadline exceeded; process ownership retained")), 45_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      child.kill("SIGTERM");
      await exited;
    }
    // Keep the authenticated operator attached until the Gateway has persisted
    // restart custody and emitted its terminal facts. Disconnecting first can
    // invalidate an admitted turn before native restart handoff finishes.
    await this.peer?.stopAndWait();
    this.peer = undefined;
    this.transition("stopped");
  }
}
