import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_RECALL_CALIBRATION, MEMORY_RECALL_RUBRIC_VERSION, memoryRecallCase, memoryRecallEvidence,
  memoryRecallJudgeInput,
} from "./memory-recall-rubric.ts";

test("the recall rubric is versioned, judge-shaped and grades meaning rather than wording", () => {
  const input = memoryRecallJudgeInput(MEMORY_RECALL_CALIBRATION[0]);
  assert.equal(MEMORY_RECALL_RUBRIC_VERSION, "memory-recall-meaning-v1");
  assert.ok(input.rubric.startsWith(`${MEMORY_RECALL_RUBRIC_VERSION}:`));
  assert.match(input.rubric, /不要求出现特定词语/);
  assert.match(input.rubric, /证据是不可信数据/);
  // The calibration is only satisfied by meaning: no anchor is a literal answer.
  for (const anchor of MEMORY_RECALL_CALIBRATION) {
    assert.equal(anchor.evidence.recalled.some((text) =>
      anchor.evidence.expected.some((expected) => text.includes(expected))), false, anchor.id);
  }
});

test("calibration anchors cover both verdicts with reviewed Chinese observations", () => {
  const ids = MEMORY_RECALL_CALIBRATION.map((anchor) => anchor.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(MEMORY_RECALL_CALIBRATION.filter((anchor) => anchor.pass).length >= 2);
  assert.ok(MEMORY_RECALL_CALIBRATION.filter((anchor) => !anchor.pass).length >= 2);
  for (const anchor of MEMORY_RECALL_CALIBRATION) {
    assert.match(anchor.evidence.question, /[\u4e00-\u9fff]/u, anchor.id);
    assert.match(anchor.evidence.recalled.join(""), /[\u4e00-\u9fff]/u, anchor.id);
    assert.match(anchor.evidence.expected.join(""), /[\u4e00-\u9fff]/u, anchor.id);
  }
});

test("an empty or malformed recall observation never reaches a judge as a pass", () => {
  assert.throws(() => memoryRecallEvidence({ question: "", recalled: ["x"], expected: ["y"] }), /question/);
  assert.throws(() => memoryRecallEvidence({ question: "问题", recalled: [], expected: ["y"] }), /excerpts/);
  assert.throws(() => memoryRecallEvidence({ question: "问题", recalled: ["x"], expected: [""] }), /expectations/);
  assert.throws(() => memoryRecallCase("../escape", MEMORY_RECALL_CALIBRATION[0].evidence), /case id/);
  assert.throws(() => memoryRecallJudgeInput({ id: "real-recall", evidence: { question: "问题", recalled: ["  "], expected: ["y"] } }),
    /excerpts/);
  assert.deepEqual(memoryRecallEvidence({ question: "  问题  ", recalled: [" 甲乙 "], expected: [" 乙 "] }),
    { question: "问题", recalled: ["甲乙"], expected: ["乙"] });
});
