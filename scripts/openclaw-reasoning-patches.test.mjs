import assert from "node:assert/strict";
import { test } from "node:test";
import {
  patchReasoningCompat,
  patchReasoningStream,
  patchThinkingTransport,
} from "./openclaw-reasoning-patches.mjs";

test("agent entry respects the session's visibility setting and upgrades the earlier patch", () => {
  const original = "return runEmbeddedPiAgent({\n\t\tfastMode: params.fastMode,\n});";
  const patched = patchReasoningStream(original);
  const run = new Function("params", "runEmbeddedPiAgent", patched);
  for (const level of [undefined, "off", "on", "stream"]) {
    const result = run(
      { sessionEntry: level ? { reasoningLevel: level } : undefined },
      (value) => value,
    );
    assert.equal(result.reasoningLevel, level ?? "off");
    assert.equal(typeof result.onReasoningStream === "function", level === "stream");
  }
  assert.equal(patchReasoningStream(patched), patched);
  const old = original.replace(
    "\t\tfastMode: params.fastMode,\n",
    '\t\tfastMode: params.fastMode,\n\t\treasoningLevel: params.resolvedReasoningLevel ?? "stream",\n\t\tonReasoningStream: () => {},\n',
  );
  assert.equal(patchReasoningStream(old), patched);
});

test("thinking payload follows explicit protocol compatibility, not the model name", () => {
  const original =
    "\telse if (resolvedCompletionsReasoningEffort && model.reasoning && compat.supportsReasoningEffort && !omitGpt54MiniToolReasoningEffort) params.reasoning_effort = resolvedCompletionsReasoningEffort;\n";
  const patched = patchThinkingTransport(original);
  const build = new Function(
    "model",
    "compat",
    "resolvedCompletionsReasoningEffort",
    `const params = {}; const omitGpt54MiniToolReasoningEffort = false; if (false) {}\n${patched}\nreturn params;`,
  );
  assert.deepEqual(
    build(
      { id: "synthetic", reasoning: true },
      { supportsReasoningEffort: true, thinkingFormat: "deepseek" },
      "high",
    ),
    { reasoning_effort: "high", thinking: { type: "enabled" } },
  );
  assert.deepEqual(
    build({ id: "deepseek-model", reasoning: true }, { supportsReasoningEffort: true }, "high"),
    { reasoning_effort: "high" },
  );
  assert.deepEqual(
    build(
      { reasoning: true },
      { supportsReasoningEffort: false, thinkingFormat: "deepseek" },
      "high",
    ),
    {},
  );
  assert.equal(patchThinkingTransport(patched), patched);
});

test("unknown or ambiguous runtime shapes fail closed", () => {
  assert.throws(() => patchReasoningStream("unrecognized"));
  assert.throws(() => patchReasoningStream("\t\tfastMode: params.fastMode,\n".repeat(2)));
  assert.throws(() => patchThinkingTransport("unrecognized"));
});

test("bridges configured effort mapping into embedded pi-ai without changing other APIs", () => {
  const original = "function normalizeModelCompat(model) {\nreturn model;\n}";
  const patched = patchReasoningCompat(original);
  const normalize = new Function(`${patched}; return normalizeModelCompat;`)();
  const model = {
    api: "openai-completions",
    thinkingLevelMap: { low: "low", medium: "medium" },
    compat: { reasoningEffortMap: { medium: "high" } },
  };
  assert.deepEqual(normalize(model).thinkingLevelMap, { low: "low", medium: "high" });
  assert.equal(model.thinkingLevelMap.medium, "medium");
  const other = { ...model, api: "anthropic-messages" };
  assert.equal(normalize(other), other);
  assert.equal(patchReasoningCompat(patched), patched);
});
