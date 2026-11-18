function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2)
    throw new Error("Runtime anchor is missing or ambiguous; nothing changed");
  return source.replace(anchor, replacement);
}

export function patchReasoningStream(source) {
  const old =
    '\t\treasoningLevel: params.resolvedReasoningLevel ?? "stream",\n\t\tonReasoningStream: () => {},\n';
  const patch =
    '\t\treasoningLevel: params.sessionEntry?.reasoningLevel ?? "off",\n' +
    '\t\tonReasoningStream: params.sessionEntry?.reasoningLevel === "stream" ? () => {} : void 0,\n';
  if (source.includes(patch)) return source;
  if (source.includes(old)) return replaceOnce(source, old, patch);
  const anchor = "\t\tfastMode: params.fastMode,\n";
  return replaceOnce(source, anchor, anchor + patch);
}

export function patchThinkingTransport(source) {
  const old =
    '\tif (params.reasoning_effort && /deepseek/i.test(String(model.id ?? ""))) params.thinking = { type: "enabled" };\n';
  const patch =
    '\tif (params.reasoning_effort && compat.thinkingFormat === "deepseek") params.thinking = { type: "enabled" };\n';
  if (source.includes(patch)) return source;
  if (source.includes(old)) return replaceOnce(source, old, patch);
  const anchor =
    "\telse if (resolvedCompletionsReasoningEffort && model.reasoning && compat.supportsReasoningEffort && !omitGpt54MiniToolReasoningEffort) params.reasoning_effort = resolvedCompletionsReasoningEffort;\n";
  return replaceOnce(source, anchor, anchor + patch);
}

/** The embedded pi-ai transport reads thinkingLevelMap rather than compat's map. */
export function patchReasoningCompat(source) {
  const anchor = "function normalizeModelCompat(model) {\n";
  const patch =
    '\tif (model.api === "openai-completions" && model.compat?.reasoningEffortMap) model = {\n' +
    "\t\t...model,\n" +
    "\t\tthinkingLevelMap: { ...model.thinkingLevelMap, ...model.compat.reasoningEffortMap }\n" +
    "\t};\n";
  if (source.includes(anchor + patch)) return source;
  return replaceOnce(source, anchor, anchor + patch);
}
