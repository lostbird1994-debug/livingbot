import type { GatewayRequests } from "./contracts.ts";
import { validateAgentId } from "./config.ts";
import type { MemoryForgetOutcome, MemoryForgetPreview, MemoryForgetPreviewProvider, MemoryForgetRecovery, MemoryRestore } from "./memory-forget.ts";

export type MemoryReference = { providerId: string; id: string; revision?: string; fragment?: string };
export type MemoryCitation = { label: string; reference?: MemoryReference; startLine?: number; endLine?: number };
export type MemoryHit = { reference: MemoryReference; excerpt: string; score?: number; source?: string; citations: MemoryCitation[] };
export type MemoryPage = { providerId: string; hits: MemoryHit[]; nextCursor?: string; coverage?: "complete" | "partial"; warning?: string };
export type MemoryHealth = { providerId: string; status: "ready" | "degraded" | "unavailable"; mode: "text" | "hybrid" | "unknown" };
export type MemoryDocument = { status: "ok"; reference: MemoryReference; text: string; citations: MemoryCitation[]; truncated: boolean; nextFrom?: number } | { status: "not_found" };
export type MemoryQuery = { query: string; limit?: number; cursor?: string; sources?: ("memory" | "sessions")[] };
export interface MemoryProvider {
  previewForget?(agentId: string, sessions: string[]): Promise<MemoryForgetPreview>;
  prepareForget?(agentId: string, sessions: string[], expectedDigest: string): Promise<MemoryForgetRecovery>;
  applyForget?(agentId: string, sessions: string[], expectedDigest: string, requestId?: string): Promise<MemoryForgetOutcome>;
  forgetOutcome?(agentId: string, sessions: string[], expectedDigest: string, requestId: string): Promise<MemoryForgetOutcome | undefined>;
  /** Restores a reviewed recovery copy to an independent target; never activates it. */
  restoreForget?(recoveryId: string): Promise<MemoryRestore>;
  health(agentId: string): Promise<MemoryHealth>;
  search(agentId: string, query: MemoryQuery): Promise<MemoryPage>;
  get(agentId: string, reference: MemoryReference, from?: number): Promise<MemoryDocument>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory response");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 4096): string {
  if (typeof value !== "string" || !value || value.length > limit) throw new Error("Invalid memory field");
  return value;
}
export function memoryReference(value: unknown): MemoryReference {
  const entry = object(value);
  return {
    providerId: text(entry.providerId, 128), id: text(entry.id),
    ...(entry.revision !== undefined ? { revision: text(entry.revision) } : {}),
    ...(entry.fragment !== undefined ? { fragment: text(entry.fragment) } : {}),
  };
}
function citations(value: unknown): MemoryCitation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid memory citations");
  return value.map((item) => {
    const entry = object(item);
    return {
      label: text(entry.label),
      ...(entry.reference ? { reference: memoryReference(entry.reference) } : {}),
      ...(Number.isInteger(entry.startLine) && Number(entry.startLine) > 0 ? { startLine: Number(entry.startLine) } : {}),
      ...(Number.isInteger(entry.endLine) && Number(entry.endLine) > 0 ? { endLine: Number(entry.endLine) } : {}),
    };
  });
}

/** Operator-only native memory reads. Agent turns keep their native audience-bound tools. */
export class OpenClawMemory implements MemoryProvider {
  private readonly gateway: GatewayRequests;
  private readonly forgetting?: MemoryForgetPreviewProvider;
  constructor(gateway: GatewayRequests, forgetting?: MemoryForgetPreviewProvider) {
    this.gateway = gateway; this.forgetting = forgetting;
  }

  previewForget(agentId: string, sessions: string[]): Promise<MemoryForgetPreview> {
    if (!this.forgetting) throw new Error("Memory forgetting preview is unavailable");
    return this.forgetting.preview(agentId, sessions);
  }
  prepareForget(agentId: string, sessions: string[], expectedDigest: string): Promise<MemoryForgetRecovery> {
    if (!this.forgetting?.prepare) throw new Error("Memory recovery preparation is unavailable");
    return this.forgetting.prepare(agentId, sessions, expectedDigest);
  }
  applyForget(agentId: string, sessions: string[], expectedDigest: string, requestId?: string): Promise<MemoryForgetOutcome> {
    if (!this.forgetting?.apply) throw new Error("Recoverable memory forgetting is unavailable");
    return this.forgetting.apply(agentId, sessions, expectedDigest, requestId);
  }
  forgetOutcome(agentId: string, sessions: string[], expectedDigest: string, requestId: string): Promise<MemoryForgetOutcome | undefined> {
    return this.forgetting?.outcome?.(agentId, sessions, expectedDigest, requestId) ?? Promise.resolve(undefined);
  }
  restoreForget(recoveryId: string): Promise<MemoryRestore> {
    if (!this.forgetting?.restore) throw new Error("Memory recovery restore is unavailable");
    return this.forgetting.restore(recoveryId);
  }

  private async read(method: string, agentId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    validateAgentId(agentId);
    const response = object(await this.gateway.request(method, { agentId, ...input }));
    if (response.agentId !== agentId || response.version !== 2) throw new Error("Memory response ownership mismatch");
    text(response.providerId, 128);
    return response;
  }

  async health(agentId: string): Promise<MemoryHealth> {
    const result = await this.read("memory.status", agentId);
    if (!["ready", "degraded", "unavailable"].includes(String(result.status))) throw new Error("Invalid memory health");
    const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
    const legacy = details.legacy && typeof details.legacy === "object" ? details.legacy as Record<string, unknown> : {};
    const custom = legacy.custom && typeof legacy.custom === "object" ? legacy.custom as Record<string, unknown> : {};
    return {
      providerId: String(result.providerId), status: result.status as MemoryHealth["status"],
      mode: custom.searchMode === "fts-only" || legacy.provider === "none" ? "text" : custom.searchMode === "hybrid" ? "hybrid" : "unknown",
    };
  }

  async search(agentId: string, query: MemoryQuery): Promise<MemoryPage> {
    if (!query || typeof query.query !== "string" || !query.query.trim() || query.query.length > 4000) throw new Error("Enter a memory query");
    const limit = query.limit ?? 12;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid memory result limit");
    if (query.sources !== undefined && (!Array.isArray(query.sources) || !query.sources.length ||
      query.sources.some((source) => source !== "memory" && source !== "sessions"))) throw new Error("Invalid memory sources");
    const result = await this.read("memory.search", agentId, {
      version: 2, query: query.query.trim(), maxResults: limit,
      ...(query.cursor !== undefined ? { cursor: text(query.cursor) } : {}),
      ...(query.sources ? { sources: [...new Set(query.sources)] } : {}),
    });
    if (!Array.isArray(result.hits) || result.hits.length > limit) throw new Error("Invalid memory result count");
    const providerId = String(result.providerId);
    const hits = result.hits.map((item) => {
      const entry = object(item);
      const reference = memoryReference(entry.reference);
      if (reference.providerId !== providerId) throw new Error("Memory reference provider mismatch");
      if (typeof entry.excerpt !== "string") throw new Error("Invalid memory excerpt");
      return {
        reference, excerpt: entry.excerpt.slice(0, 16_000), citations: citations(entry.citations),
        ...(typeof entry.score === "number" && Number.isFinite(entry.score) ? { score: entry.score } : {}),
        ...(typeof entry.source === "string" ? { source: entry.source.slice(0, 128) } : {}),
      };
    });
    return {
      providerId, hits,
      ...(result.nextCursor !== undefined ? { nextCursor: text(result.nextCursor) } : {}),
      ...(result.coverage === "complete" || result.coverage === "partial" ? { coverage: result.coverage } : {}),
      ...(typeof result.warning === "string" ? { warning: result.warning.slice(0, 4000) } : {}),
    };
  }

  async get(agentId: string, reference: MemoryReference, from = 1): Promise<MemoryDocument> {
    const selected = memoryReference(reference);
    if (!Number.isInteger(from) || from < 1) throw new Error("Invalid memory line");
    const result = await this.read("memory.get", agentId, { reference: selected, from, lines: 100 });
    if (result.status === "not_found") return { status: "not_found" };
    if (result.status !== "ok" || typeof result.text !== "string" || result.text.length > 200_000) throw new Error("Invalid memory document");
    const returned = memoryReference(result.reference);
    if (returned.providerId !== selected.providerId || returned.id !== selected.id ||
      (selected.revision !== undefined && returned.revision !== selected.revision)) throw new Error("Memory source changed");
    return {
      status: "ok", reference: returned, text: result.text, citations: citations(result.citations), truncated: result.truncated === true,
      ...(Number.isInteger(result.nextFrom) && Number(result.nextFrom) > from ? { nextFrom: Number(result.nextFrom) } : {}),
    };
  }
}
