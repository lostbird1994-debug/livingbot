export type KernelFrame = {
  event: string;
  seq?: number;
  payload?: Record<string, unknown>;
};

export type GatewayHello = {
  server?: { version?: string };
  features?: { methods?: string[]; events?: string[] };
};

export interface GatewayRequests {
  request<T = unknown>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
}

export interface GatewayPeer extends GatewayRequests {
  start(): void;
  stopAndWait(): Promise<void>;
  request<T = unknown>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
}

export type PeerOptions = {
  url: string;
  token: string;
  env: NodeJS.ProcessEnv;
  onEvent(frame: KernelFrame): void;
  onHelloOk(hello: GatewayHello): void;
  onClose(code: number, reason: string): void;
  onConnectError(error: Error): void;
};

export type PeerFactory = (options: PeerOptions) => Promise<GatewayPeer>;

export type EngineSession = {
  key: string;
  sessionId?: string;
  snapshotAt?: number;
  status?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  lastRunId?: string;
  abortedLastRun?: boolean;
  activeLeafEntryId?: string | null;
};

export type HistoryPage = {
  kind?: "delta" | "reset";
  sessionInfo?: EngineSession;
  messages?: Record<string, unknown>[];
  deltaCursor?: string;
  inFlightRun?: Record<string, unknown>;
  pendingInputs?: {
    items: { id: string; runId?: string; state: string; acceptedAt?: number }[];
    total?: number;
    queuedCount?: number;
  };
  inputReceipts?: {
    runId: string;
    state: "pending" | "consumed";
    queued?: true;
    cancelled?: true;
    consumedByEventId?: string;
  }[];
};

export type Submission = {
  sessionOwner?: { agentId: string; kind: "private" | "group" };
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  sessionId?: string;
  expectedLeafEntryId?: string | null;
  queueMode?: "steer" | "followup" | "collect" | "interrupt";
  timeoutMs?: number;
  attachments?: { type: string; mimeType: string; fileName: string; content: string }[];
};

export type Acceptance = {
  runId: string;
  status: string;
  messageSeq?: number;
};

export type ProcessSummary = {
  processId: string;
  instanceId: string;
  name: string;
  status: "running" | "completed" | "failed" | "killed";
  startedAt: number;
  endedAt?: number;
  tail: string;
  canStop: boolean;
  exitCode?: number | null;
  exitSignal?: string | number | null;
  exitReason?: string;
};

export type ProcessPage = {
  sessionId: string;
  processes: ProcessSummary[];
  truncated: boolean;
};

export type RuntimePhase = "stopped" | "starting" | "connecting" | "ready" | "recovering" | "stopping" | "failed";

export type RuntimeObservation =
  | { type: "phase"; phase: RuntimePhase; generation: number; detail?: string }
  | { type: "frame"; frame: KernelFrame; generation: number }
  | { type: "gap"; expected: number; actual: number; generation: number }
  | { type: "disconnected"; code: number; reason: string; generation: number }
  | { type: "ready"; hello: GatewayHello; generation: number }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null; generation: number };
