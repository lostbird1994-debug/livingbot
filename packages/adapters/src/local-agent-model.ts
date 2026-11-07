export type LocalAgentEngine = "codex" | "workbuddy";
export type LocalAgentSelection = { engine: LocalAgentEngine; modelId?: string };

/** One canonical id for engine + native model, also used by the local broker. */
export function parseLocalAgentSelection(id: string): LocalAgentSelection | undefined {
  for (const engine of ["codex", "workbuddy"] as const) {
    const prefix = `native/${engine}`;
    if (id === prefix) return { engine };
    if (!id.startsWith(`${prefix}/`)) continue;
    try {
      const encoded = id.slice(prefix.length + 1);
      const modelId = decodeURIComponent(encoded);
      if (
        !modelId ||
        modelId.trim() !== modelId ||
        /[\u0000-\u001f\u007f]/.test(modelId) ||
        encodeURIComponent(modelId) !== encoded ||
        id.length > 200
      )
        return;
      return { engine, modelId };
    } catch {
      return;
    }
  }
}

export function localAgentModelId(engine: LocalAgentEngine, modelId: string): string {
  const id = `native/${engine}/${encodeURIComponent(modelId)}`;
  if (parseLocalAgentSelection(id)?.modelId !== modelId) throw new Error("Invalid native model id");
  return id;
}
