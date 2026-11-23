import type { MemoryForgetPreview } from "./memory-forget.ts";

/** Presentation of native counters; safe to share with the browser. */
export type MemoryForgetScopeId =
  | "memory-documents" | "session-transcripts" | "retrieval-index" | "short-term" | "native-backups" | "curated-writes";
export type MemoryForgetScope = { id: MemoryForgetScopeId; affected: boolean; counts: Record<string, number> };
const scopeArtifacts: Record<Exclude<MemoryForgetScopeId, "curated-writes">, readonly string[]> = {
  "memory-documents": ["memoryFiles", "memoryEntries", "memoryLines"],
  "session-transcripts": ["sessionCorpusFiles", "sessionCorpusLines"],
  "retrieval-index": ["indexChunks", "indexSources", "ftsRows", "vectorRows", "embeddingCacheRows"],
  "short-term": ["shortTermEntries", "seenHashScopes"],
  "native-backups": ["backups", "originRows"],
};
export function memoryForgetScopeSummary(report: MemoryForgetPreview): MemoryForgetScope[] {
  const scopes: MemoryForgetScope[] = Object.entries(scopeArtifacts).map(([id, keys]) => {
    const counts = Object.fromEntries(keys.map((key) => [key, report.artifacts[key] ?? 0]));
    return { id: id as MemoryForgetScopeId, affected: Object.values(counts).some((count) => count > 0), counts };
  });
  scopes.push({
    id: "curated-writes", affected: report.curatedWrites.length > 0,
    counts: { curatedWrites: report.curatedWrites.length },
  });
  return scopes;
}
