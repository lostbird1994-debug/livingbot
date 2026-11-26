import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeCronReplay,
  restoreCronPayloadMirror, restoreCronResultCommit, patchCronResultReplay,
} from "./openclaw-cron-result-patches.mjs";

const report = "Synthetic routine report: all scheduled checks completed successfully.\n\n" +
  "The first source has one new item. The second source is unchanged. No external messages were sent.";
const input = (jobId = "job-a", runId = "occurrence-a") => ({
  role: "user", content: "Run the synthetic routine.",
  provenance: { kind: "internal_system", sourceTool: "cron_execution", jobId, runId },
});
const assistant = (text = report) => ({
  role: "assistant", provider: "synthetic", model: "synthetic", stopReason: "stop",
  display: false, __openclaw: { runId: "native-run-a" }, content: [{ type: "text", text }],
});
const mirror = (text = report) => ({
  role: "assistant", provider: "openclaw", api: "openclaw-transcript", model: "automation-result",
  stopReason: "stop", content: [{ type: "text", text }],
  openclawAutomation: { kind: "cron", jobId: "job-a", runId: "occurrence-a" },
});

test("replay preserves repeated report text verbatim in string and block content", () => {
  for (const separator of ["", " ", "\n", "\n\n"]) {
    for (const copies of [2, 3, 6]) {
      const text = Array(copies).fill(report).join(separator);
      for (const content of [text, [{ type: "text", text }]]) {
        const result = { ...mirror(), content };
        assert.equal(canonicalizeCronReplay([input(), assistant(text), result])[1], result);
      }
    }
  }
});

test("replays one result for the same cron occurrence without mutating the audit history", () => {
  const raw = [input(), assistant(`${report}\n${report}`), mirror(`${report}\n${report}`)];
  const before = structuredClone(raw);
  const normalized = canonicalizeCronReplay(raw);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[1].content[0].text, `${report}\n${report}`);
  assert.deepEqual(raw, before);
  assert.deepEqual(canonicalizeCronReplay(normalized), normalized);
});

test("ownership rather than matching prose decides which source record is superseded", () => {
  const source = assistant("An internal draft with different wording.");
  assert.deepEqual(canonicalizeCronReplay([input(), source, mirror()]), [input(), mirror()]);
  for (const messages of [
    [input("other-job"), assistant(), mirror()],
    [input("job-a", "other-occurrence"), assistant(), mirror()],
    [assistant(), mirror()],
    [input(), { ...assistant(), display: true }, mirror()],
    [input(), { ...assistant(), __openclaw: undefined }, mirror()],
    [input(), assistant(), { role: "user", content: "A new request." }, mirror()],
    [input(), { ...assistant(), stopReason: "toolUse" }, mirror()],
    [input(), { ...assistant(), content: [{ type: "toolCall", id: "call-a" }] }, mirror()],
  ]) assert.equal(canonicalizeCronReplay(messages), messages);
});

test("replays one report while retaining provider reasoning and structured content", () => {
  const thinking = { type: "thinking", thinking: "Synthetic reasoning", thinkingSignature: "synthetic-signature" };
  const source = { ...assistant(), content: [thinking, ...assistant().content] };
  const messages = [input(), source, mirror()];
  const before = structuredClone(messages);
  const normalized = canonicalizeCronReplay(messages);
  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[1].content, [thinking]);
  assert.equal(normalized[1].content[0], thinking);
  assert.equal(normalized.flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .filter((b) => b.type === "text").length, 1);
  assert.deepEqual(messages, before);
  assert.equal(canonicalizeCronReplay(normalized), normalized);
});

test("independent background results and ordinary repeated replies retain their boundaries", () => {
  const repeated = `${report}\n\n${report}`;
  for (const message of [
    assistant(repeated),
    { ...mirror(repeated), openclawAutomation: { kind: "subagent-completion" } },
    { ...mirror(repeated), api: "unknown" },
  ]) {
    const messages = [message];
    assert.equal(canonicalizeCronReplay(messages), messages);
  }
  const messages = [mirror()];
  assert.equal(canonicalizeCronReplay(messages), messages);
});

test("upgrades commits to native behavior and removes the former text fallback", () => {
  const original = 'import "node:fs";\nfunction commit(e) {\n\tconst n = normalizeOptionalString(e.text);\nreturn n;\n}';
  const legacy = 'function normalizeCronReportText(value) {\nreturn "cropped";\n}\n' + original.replace(
    "normalizeOptionalString(e.text)",
    'normalizeOptionalString(e.provenance?.kind === "cron" ? normalizeCronReportText(e.text) : e.text)',
  );
  const restored = restoreCronResultCommit(legacy);
  assert.equal(restored, original);
  assert.equal(restoreCronResultCommit(restored), restored);
  const commit = new Function("normalizeOptionalString", `${restored.replace('import "node:fs";', "")}; return commit;`)((text) => text?.trim());
  assert.equal(commit({ text: `${report}\n${report}`, provenance: { kind: "cron" } }), `${report}\n${report}`);
  assert.throws(() => restoreCronResultCommit(legacy.slice(legacy.indexOf("import "))));
});


test("replay patch executes the canonicalization in the existing native pipeline", () => {
  const source = "function normalizeAssistantReplayContent(e) {\nreturn e;\n}";
  const unpatchedNormalize = new Function(`${source}; return normalizeAssistantReplayContent;`)();
  assert.equal(unpatchedNormalize([input(), assistant(), mirror()]).length, 3);
  const patched = patchCronResultReplay(source);
  const normalize = new Function(`${patched}; return normalizeAssistantReplayContent;`)();
  assert.equal(normalize([input(), assistant(), mirror()]).length, 2);
  assert.equal(patchCronResultReplay(patched), patched);
});

test("replay patch upgrades earlier helpers and stays idempotent", () => {
  const native = 'import "node:fs";\nfunction normalizeAssistantReplayContent(e) {\nreturn e;\n}';
  const old = 'function normalizeCronReportText(value) {\nreturn "cropped";\n}\n' +
    'function canonicalizeCronReplay(messages) {\nreturn normalizeCronReportText(messages);\n}\n' +
    native.replace("function normalizeAssistantReplayContent(e) {\n",
      "function normalizeAssistantReplayContent(e) {\n\te = canonicalizeCronReplay(e);\n");
  const upgraded = patchCronResultReplay(old);
  assert.equal(upgraded, patchCronResultReplay(native));
  assert(!upgraded.includes("normalizeCronReportText"));
  assert.equal(patchCronResultReplay(upgraded), upgraded);
  assert.throws(() => patchCronResultReplay(old.slice(old.indexOf("import "))));
});

test("canonical replay preserves result media and ordinary user messages byte for byte", () => {
  const image = { type: "image", mimeType: "image/png", data: "synthetic-image" };
  const message = { ...mirror(`${report}\n${report}`), content: [
    { type: "text", text: `${report}\n${report}` }, image,
  ] };
  const user = { role: "user", content: `${report}\n${report}` };
  const result = canonicalizeCronReplay([user, message]);
  assert.equal(result[0], user);
  assert.equal(result[1].content[0].text, `${report}\n${report}`);
  assert.equal(result[1].content[1], image);
  assert.equal(message.content[0].text, `${report}\n${report}`);
});

test("restores payload multiplicity even when different payloads have identical text", () => {
  const source = 'return {\n\t\ttext: e.map(({ payload: e }) => resolveOutboundPayloadMirrorText(e)).filter((e) => Boolean(e)).join("\\n"),\n};';
  const legacy = 'return {\n\t\ttext: [...new Set(e.map(({ payload: e }) => resolveOutboundPayloadMirrorText(e)).filter((e) => Boolean(e)))].join("\\n"),\n};';
  const restored = restoreCronPayloadMirror(legacy);
  assert.equal(restored, source);
  const project = new Function("e", "resolveOutboundPayloadMirrorText", restored);
  assert.equal(project([{ payload: report }, { payload: report }, { payload: "Separate report" }], (text) => text).text,
    `${report}\n${report}\nSeparate report`);
  assert.equal(restoreCronPayloadMirror(restored), restored);
});

test("unknown or ambiguous runtime versions fail before any writes", () => {
  for (const patch of [restoreCronResultCommit, patchCronResultReplay, restoreCronPayloadMirror]) {
    assert.throws(() => patch("unknown"));
  }
  assert.throws(() => restoreCronResultCommit("\tconst n = normalizeOptionalString(e.text);\n".repeat(2)));
  assert.throws(() => patchCronResultReplay("function normalizeAssistantReplayContent(e) {\n".repeat(2)));
});
