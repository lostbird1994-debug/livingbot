import assert from "node:assert/strict";
import { test } from "node:test";
import { patchSkillWorkshopNotice } from "./openclaw-silent-skill-notice.mjs";

test("skill workshop keeps learning but emits no chat notice or undo system event", () => {
  const source = [
    "const log = { debug() {} };",
    "async function postWorkshopChangeNotice(e) {",
    "  enqueueSystemEvent('undo context');",
    "  await appendAssistantMessageToSessionTranscript({ text: 'Learned: created skill' });",
    "}",
    "//#endregion",
  ].join("\n");
  const patched = patchSkillWorkshopNotice(source);
  assert.match(patched, /changes saved silently/);
  assert.doesNotMatch(patched, /enqueueSystemEvent|appendAssistantMessageToSessionTranscript|Learned:/);
  assert.equal(patchSkillWorkshopNotice(patched), patched);
  assert.throws(() => patchSkillWorkshopNotice("async function unrelated() {}"), /anchor is missing/);
});
