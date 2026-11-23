/**
 * A native tool payload is arbitrary output: file bytes, shell commands,
 * request headers, environment. Nothing inside it can be classified reliably,
 * so a tool step retains an explicit projection instead of the payload:
 * ownership and status for pairing, plus scalar outcomes for the result.
 * Whatever cannot be expressed this way stays out of the product journal.
 */
const ownership = ["toolCallId", "itemId", "parentToolCallId", "name", "phase"];
const identifier = /^[A-Za-z0-9_.:@/-]{1,120}$/;
const counted = new Set(["bytes", "count", "total", "changed", "lines", "chars", "size", "durationMs", "exitCode"]);
const flags = new Set(["ok", "success", "exists", "truncated", "delivered"]);
const states = new Set([
  "start", "running", "update", "result", "partial", "completed", "failed", "cancelled",
  "error", "timeout", "skipped", "accepted", "rejected", "queued", "delivered",
]);
const limits = { fields: 12, value: 1_200 } as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function outcomesOf(source: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of counted) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
  }
  for (const key of flags) {
    if (typeof source[key] === "boolean") kept[key] = source[key];
  }
  const status = source.status;
  if (typeof status === "string" && states.has(status)) kept.status = status;
  const signal = source.exitSignal;
  if (typeof signal === "string" && /^[A-Z0-9-]{1,16}$/.test(signal)) kept.exitSignal = signal;
  return kept;
}

/** Bounded, non-disclosing rendering of one native tool step. */
export function toolDetail(data: Record<string, unknown>): string | undefined {
  const detail: Record<string, unknown> = {};
  for (const key of ownership) {
    const value = data[key];
    if (typeof value === "string" && identifier.test(value)) detail[key] = value;
  }
  // A completed step reports through result; a running one through partialResult.
  const result = outcomesOf(record(data.result));
  const partial = outcomesOf(record(data.partialResult));
  const top = outcomesOf(data);
  const outcome = Object.keys(result).length ? result
    : Object.keys(partial).length ? partial : top;
  const kept = Object.entries(outcome).slice(0, limits.fields);
  if (kept.length) detail.outcome = Object.fromEntries(kept);
  if (!Object.keys(detail).length) return undefined;
  const text = JSON.stringify(detail, null, 2);
  return text.length <= limits.value ? text : undefined;
}
