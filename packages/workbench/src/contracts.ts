export const fileLimits = { bytes: 25 * 1024 * 1024, attachments: 10 } as const;

export type Bot = {
  id: string;
  /** Product workspace; absent on legacy records, which belong to `local`. */
  spaceId?: string;
  agentId: string;
  name: string;
  description: string;
  identity: string;
  color: string;
  createdAt: number;
  /** Which avatar set the Bot wears; absent means the default artwork. */
  avatarSet?: string;
  /** Pinned Bots come first in the panorama and the sidebar. */
  pinned?: boolean;
  /** Manual order inside its section; older records without it sort last. */
  position?: number;
  /** Section (folder) this Bot belongs to; absent means the unsectioned list. */
  sectionId?: string;
  archivedAt?: number;
  /** Recoverably removed; source files and history are retained. */
  removedAt?: number;
  spawnKey?: string;
  notifyOnFinish?: boolean;
  autoSpeak?: boolean;
  voiceId?: string;
};

/** A sidebar/panorama section. Order is explicit so a rename never reshuffles. */
export type BotSection = { id: string; name: string; position: number; createdAt: number; spaceId?: string };

export type ScratchpadItem = {
  id: string;
  botId: string;
  title: string;
  status: "open" | "parked" | "done";
  notes: string;
  createdAt: string;
  updatedAt: string;
  removedAt?: string;
};

export type Conversation = {
  id: string;
  /** Product workspace; absent on legacy records, which belong to `local`. */
  spaceId?: string;
  kind: "private" | "group";
  title: string;
  botIds: string[];
  createdAt: number;
  /** Archived groups keep their messages but leave the navigation. */
  archivedAt?: number;
  /** Transcript cleared at this time; earlier messages stay stored but out of view. */
  clearedAt?: number;
  /** The Bot's own conversation. Task sessions are private too, but never the home one. */
  main?: boolean;
  pinned?: boolean;
  sectionId?: string;
  updatedAt?: number;
};

export type ProductSpace = {
  id: string;
  name: string;
  createdAt: number;
};

export type TaskStatus =
  | "queued" | "running" | "waiting" | "stopping"
  | "completed" | "failed" | "cancelled" | "interrupted";

export type Task = {
  id: string;
  botId: string;
  conversationId: string;
  reportConversationId: string;
  parentTaskId?: string;
  fileBatchId?: string;
  delegation?: {
    executor: string;
    sessionKey: string;
    parentRunId: string;
    toolCallId: string;
  };
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  stopRequestedAt?: number;
  inputDisposition?: "steered";
  continuationSubmissionId?: string;
  routine?: { id: string; jobId: string; sessionId: string; occurrenceId: string; runId: string };
  processes?: TaskProcess[];
};

export type TaskProcess = {
  id: string;
  runId: string;
  sessionKey: string;
  toolCallId: string;
  processId: string;
  startedAt: number;
  instanceId?: string;
  nativeSessionId?: string;
  canStop?: boolean;
  foreground?: boolean;
  status: "unknown" | "running" | "stopping" | "completed" | "failed" | "killed" | "unavailable";
  stopError?: string;
  errorKind?: "observation" | "stop";
  exitCode?: number | null;
  exitSignal?: string | number | null;
  exitReason?: string;
};

export type VoicePlaybackReceipt = { messageId: string; heardText: string };
export type Block = (
  | { id: string; kind: "text" | "reasoning"; text: string; voicePlayback?: VoicePlaybackReceipt }
  | { id: string; kind: "tool"; name: string; title: string; phase: string; detail?: string; parentId?: string }
  | { id: string; kind: "approval" | "question"; requestId: string; title: string; payload: Record<string, unknown> }
  | { id: string; kind: "file"; artifactId: string; name: string; mediaType: string }
  | { id: string; kind: "voice_call"; callId: string; title: string; farewell: string; durationSeconds?: number }
  | { id: string; kind: "call_request"; callId: string; reason: string; opening: string; status: "ringing" | "answered" | "declined" | "missed"; expiresAt: string; durationSeconds?: number }
  | { id: string; kind: "widget"; title: string; docId: string; sessionKey: string }
) & { native?: { messageId: string; seq?: number } };

export type Message = {
  id: string;
  conversationId: string;
  botId?: string;
  role: "user" | "assistant" | "system";
  taskId?: string;
  runId?: string;
  blocks: Block[];
  final: boolean;
  /** Native whole-reply silence; execution evidence remains stored. */
  silent?: boolean;
  createdAt: number;
  updatedAt: number;
  /** A reaction or emoji reply answers this message; the transcript renders it there. */
  replyToMessageId?: string;
  replyQuote?: string;
  clientNonce?: string;
};

export type Ability = {
  id: string;
  name: string;
  description: string;
  kind: "method" | "service" | "connector" | "tool" | "executor";
  source: string;
  version: string;
  permissions: string[];
  botIds: string[];
  state: "available" | "enabled" | "needs-authorization" | "disabled";
  configuration?: Record<string, unknown>;
  access?: Record<string, { enabled: boolean; ready: boolean; manageable: boolean; reason?: string }>;
};

export type Artifact = {
  id: string;
  botId: string;
  taskId?: string;
  conversationId: string;
  name: string;
  path: string;
  mediaType: string;
  bytes: number;
  digest: string;
  createdAt: number;
  origin?: "attachment" | "delivery";
  sourcePath?: string;
  supersedesId?: string;
  trashedAt?: number;
  recoveryPath?: string;
};

export type FilePage = {
  files: Omit<Artifact, "path">[];
  next?: string;
};

export type ProductEvent = {
  cursor: number;
  type: string;
  entityId: string;
  data: unknown;
  createdAt: number;
};

export type ResultNotification = {
  id: string;
  taskId: string;
  runId: string;
  botId: string;
  conversationId: string;
  messageId: string;
  outcome: "completed" | "failed";
  createdAt: number;
  readAt?: number;
};

export type Run = {
  id: string;
  clientNonce?: string;
  taskId: string;
  sessionKey: string;
  generation: number;
  state: TaskStatus;
  lastSequence: number;
  createdAt: number;
  endedAt?: number;
  kernelExit?: { code: number | null; signal: string | null };
};

export type SubmissionRecord = {
  id: string;
  taskId: string;
  sessionKey: string;
  message: string;
  /** Creation/onboarding prompt, retained for recovery but never a user utterance. */
  hiddenInput?: boolean;
  voicePlayback?: VoicePlaybackReceipt;
  state: "pending" | "accepted" | "rejected";
  engineRunId?: string;
  createdAt: number;
  attachmentIds?: string[];
  groupSubmissionId?: string;
  initialReportConversationId?: string;
  originBotId?: string;
  queueMode?: "followup" | "steer";
  continuationOf?: string;
  sessionId?: string;
  expectedLeafEntryId?: string | null;
};

export type GroupAssignment = { botId: string; message: string; report?: "group" | "private" };

export type GroupInput = {
  submissionId: string;
  conversationId: string;
  botIds: string[];
  message: string;
  attachmentIds?: string[];
  queueMode?: "followup" | "steer";
};

export type GroupReceipt = {
  outcomes: { botId: string; task: Task; accepted: boolean; error?: string }[];
};

export type FileBatchInput = {
  id: string;
  botId: string;
  conversationId: string;
  instruction: string;
  attachmentIds: string[];
};

export type FileBatch = FileBatchInput & {
  createdAt: number;
  items: { attachmentId: string; name: string; submissionId: string; taskId: string; accepted?: boolean; retries?: number }[];
};

export type FileBatchReceipt = GroupReceipt & { batch: FileBatch };

export type ContextShare = {
  id: string;
  sourceConversationId: string;
  destinationConversationId: string;
  messageIds: string[];
  createdAt: number;
  revokedAt?: number;
};

export type ContextPassage = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  scope: "private" | "group" | "shared";
  role: Message["role"];
  botId?: string;
  botName?: string;
  text: string;
  createdAt: number;
};

export type Snapshot = {
  bots: Bot[];
  conversations: Conversation[];
  tasks: Task[];
  abilities: Ability[];
  interactions: Interaction[];
  notifications: ResultNotification[];
  fileBatches: FileBatch[];
  cursor: number;
  /** Per-conversation read boundary, so the sidebar and transcript agree after a refresh. */
  readState: ReadState[];
  /** User emoji replies, kept as rows beside the message they answer. */
  reactions: StoredReaction[];
  /** Newest message seq per conversation, so an unread dot can be derived without loading messages. */
  lastMessageSeq: Record<string, number>;
  /** Newest message per conversation, so a sidebar row can preview it without loading the thread. */
  lastMessages: Record<string, LastMessagePreview>;
};

/** A conversation's newest visible message, reduced to what a sidebar row shows. */
export type LastMessagePreview = {
  role: Message["role"];
  /** The message's own text: the first non-empty text blocks, joined as one line. */
  text: string;
  createdAt: number;
};

export type ReadState = {
  id: string;
  conversationId: string;
  lastReadSeq: number;
  unread: boolean;
  updatedAt?: number;
};

export type StoredReaction = {
  id: string;
  conversationId: string;
  messageId: string;
  reaction: string;
  createdAt: number;
  /** A retried click resolves to the row its nonce already created. */
  clientNonce: string;
};

export type QuestionField = {
  id: string;
  header: string;
  question: string;
  options: { label: string; value: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
};

export type Interaction = {
  id: string;
  engineId: string;
  kind: "question" | "approval";
  taskId: string;
  conversationId: string;
  sessionKey: string;
  runId: string;
  generation: number;
  title: string;
  /** Display-only fields from the native exec approval request, never authorization inputs. */
  approval?: {
    taskTitle?: string;
    command?: string;
    host?: string;
    cwd?: string;
    warningText?: string;
    commandAnalysis?: {
      commandCount?: number;
      nestedCommandCount?: number;
      riskKinds: string[];
      warningLines: string[];
    };
  };
  questions: QuestionField[];
  decisions: ("allow-once" | "allow-always" | "deny")[];
  status: "pending" | "answering" | "answered" | "cancelled" | "expired" | "unavailable";
  createdAt: number;
  expiresAt: number;
  answer?: { answers?: Record<string, string[]>; decision?: "allow-once" | "allow-always" | "deny" };
};

export type InteractionAnswer =
  | { resolutionId: string; answers: Record<string, string[]> }
  | { resolutionId: string; decision: "allow-once" | "allow-always" | "deny" }
  | { resolutionId: string; cancel: true };
