export type HealthDecision = {
  issueId: string;
  choice: "defer" | "apply" | "other";
  instruction?: string;
};
export type HealthPlan = {
  steps: string[];
  limitation?: string;
  diagram?: string;
  illustration?: { title: string; format: "svg" | "html"; code: string };
};
export type HealthAction = {
  id: string;
  kind: "write" | "trash" | "instruction";
  // instruction 动作没有文件路径和版本：它交给 Bot 用自己的工具完成。
  path?: string;
  expectedDigest?: string;
  target?: string;
  steps?: string[];
  explanation: string;
  content?: string;
  beforeContent?: string;
  retainedPath?: string;
  retainedDigest?: string;
  referencePaths?: string[];
  uniqueContent?: string;
  referencesChecked?: boolean;
  processesChecked?: boolean;
  state?: "applying" | "applied" | "handed_off" | "failed";
  taskId?: string;
  error?: string;
  recovery?: string;
};
export type HealthIssue = {
  id: string;
  category: "context" | "memory" | "skills" | "workspace";
  priority: "P0" | "P1" | "P2" | "P3";
  certainty: "confirmed" | "suggestion" | "unverified";
  title: string;
  problem: string;
  impact: string;
  suggestion: string;
  evidence: { path: string; excerpt: string }[];
  actions: HealthAction[];
  plan?: HealthPlan;
  disposition?: "deferred" | "dismissed";
  dispositionReason?: string;
};
export type HealthReport = {
  id: string;
  botId: string;
  taskId: string;
  runId: string;
  version: string;
  createdAt: number;
  revision: string;
  mode: "confirm" | "silent";
  first: boolean;
  state: "checking" | "reported";
  summary: string;
  complete: boolean;
  gaps: string[];
  issues: HealthIssue[];
  coverage?: { skillKeys: string[]; readSkillKeys: string[] };
  messageId?: string;
  batch?: {
    id: string;
    state: "processing" | "completed" | "needs_review" | "review_ready" | "failed";
    decisions: HealthDecision[];
    taskId?: string;
    error?: string;
  };
};
