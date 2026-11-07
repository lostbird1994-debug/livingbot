import { describe, expect, it } from "vitest";
import { readAnsweredNativeApproval } from "./native-approval-answer.js";
const ask = {
  kind: "ask",
  text: "Confirm",
  ownerOnly: true,
  approvalRequestId: "approval-1",
  status: "answered",
  answer: "allow-once",
  actions: [
    { id: "allow-once", label: "允许一次" },
    { id: "deny", label: "拒绝" },
  ],
};
describe("native approval answer provenance", () => {
  it("reads a validated action ID and approval ID from an answered owner card", () => {
    expect(readAnsweredNativeApproval([ask])).toEqual({ id: "approval-1", actionId: "allow-once" });
    expect(readAnsweredNativeApproval([{ ...ask, answer: "deny" }])).toEqual({
      id: "approval-1",
      actionId: "deny",
    });
  });
  it.each([
    { status: "pending" },
    { ownerOnly: false },
    { approvalRequestId: undefined },
    { answer: "允许一次" },
    { answer: "Selected choice allow-once: 允许一次" },
    { answer: "allow-always" },
    { actions: [] },
  ])("rejects untrusted or unoffered choice %j", (overrides) => {
    expect(readAnsweredNativeApproval([{ ...ask, ...overrides }])).toBeUndefined();
  });
  it("does not reuse an older answered card when a newer ask is pending", () => {
    expect(
      readAnsweredNativeApproval([ask, { kind: "ask", text: "Next", status: "pending" }]),
    ).toBeUndefined();
  });
});

it("accepts owner-authenticated native question text without interpreting it as permission", () => {
  expect(
    readAnsweredNativeApproval([
      {
        kind: "ask",
        text: "Which project?",
        ownerOnly: true,
        approvalRequestId: "question-1",
        externalRequestKind: "question",
        status: "answered",
        answer: "monthly reports",
      },
    ]),
  ).toEqual({ id: "question-1", actionId: "monthly reports" });
  expect(
    readAnsweredNativeApproval([
      {
        kind: "ask",
        text: "Which project?",
        ownerOnly: false,
        approvalRequestId: "question-1",
        externalRequestKind: "question",
        status: "answered",
        answer: "monthly reports",
      },
    ]),
  ).toBeUndefined();
});
