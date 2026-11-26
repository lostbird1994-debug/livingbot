/** Prefer the committed result only when native cron occurrence ownership agrees. */
export function canonicalizeCronReplay(messages) {
  let occurrence;
  let changed = false;
  const result = [];
  for (const message of messages) {
    if (message?.role === "user") {
      const provenance = message.provenance;
      occurrence = provenance?.kind === "internal_system" && provenance.sourceTool === "cron_execution" &&
        typeof provenance.jobId === "string" && typeof provenance.runId === "string"
        ? provenance : undefined;
    }
    const automation = message?.openclawAutomation;
    if (message?.role === "assistant" && message.provider === "openclaw" &&
      message.api === "openclaw-transcript" && message.model === "automation-result" &&
      message.stopReason === "stop" && automation?.kind === "cron" &&
      typeof automation.jobId === "string" && typeof automation.runId === "string") {
      const previous = result.at(-1);
      if (occurrence?.jobId === automation.jobId && occurrence.runId === automation.runId &&
        previous?.role === "assistant" && previous.display === false && previous.stopReason === "stop" &&
        typeof previous.__openclaw?.runId === "string" && Array.isArray(previous.content) &&
        previous.content.some((block) => block.type === "text")) {
        // The committed cron result owns the visible prose. Preserve signed
        // reasoning and other structured blocks from the provider record.
        const content = previous.content.filter((block) => block.type !== "text");
        if (content.length) result[result.length - 1] = { ...previous, content };
        else result.pop();
        changed = true;
      }
    }
    result.push(message);
  }
  return changed ? result : messages;
}

function replaceOnce(source, target, replacement) {
  if (source.split(target).length !== 2) throw new Error("Cron runtime anchor is missing or ambiguous; nothing changed");
  return source.replace(target, replacement);
}

function withoutPrependedCronHelpers(source) {
  const imports = source.indexOf("\nimport ");
  if (!(source.startsWith("function normalizeCronReportText(value) {") ||
    source.startsWith("function canonicalizeCronReplay(messages) {")) || imports < 0)
    throw new Error("Cannot safely upgrade the existing cron patch");
  return source.slice(imports + 1);
}

/** Restore native commit behavior on installations with the removed fallback. */
export function restoreCronResultCommit(source) {
  const target = "\tconst n = normalizeOptionalString(e.text);";
  const legacy = "\tconst n = normalizeOptionalString(e.provenance?.kind === \"cron\" ? normalizeCronReportText(e.text) : e.text);";
  if (source.includes(legacy)) {
    source = withoutPrependedCronHelpers(replaceOnce(source, legacy, target));
    if (source.includes("normalizeCronReportText")) throw new Error("Legacy cron fallback remains");
    return source;
  }
  return replaceOnce(source, target, target);
}

export function patchCronResultReplay(source) {
  const target = "function normalizeAssistantReplayContent(e) {\n";
  const replacement = `${target}\te = canonicalizeCronReplay(e);\n`;
  const helpers = `${canonicalizeCronReplay.toString()}\n`;
  if (source.startsWith(helpers) && source.includes(replacement)) return source;
  if (source.includes(replacement))
    return helpers + replaceOnce(withoutPrependedCronHelpers(source), replacement, replacement);
  return helpers + replaceOnce(source, target, replacement);
}

/** Restore payload order and multiplicity; matching prose is not identity. */
export function restoreCronPayloadMirror(source) {
  const target = '\t\ttext: e.map(({ payload: e }) => resolveOutboundPayloadMirrorText(e)).filter((e) => Boolean(e)).join("\\n"),';
  const replacement = '\t\ttext: [...new Set(e.map(({ payload: e }) => resolveOutboundPayloadMirrorText(e)).filter((e) => Boolean(e)))].join("\\n"),';
  return source.includes(replacement) ? replaceOnce(source, replacement, target) : replaceOnce(source, target, target);
}
