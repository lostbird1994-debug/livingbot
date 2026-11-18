import type { MessageBlock } from "@livingbot/contracts";
import { describe, expect, it } from "vitest";
import { groupActivityBlocks } from "./activity-timeline";

describe("execution process boundaries", () => {
  const reasoning: MessageBlock = { kind: "reasoning", text: "Think" };
  const tools: MessageBlock = { kind: "steps", steps: [{ label: "Read", count: 1 }] };
  const prose: MessageBlock = { kind: "text", text: "I will inspect the source." };
  const answer: MessageBlock = { kind: "text", text: "The finished report." };

  it("folds the whole process, including prose, and leaves the answer outside", () => {
    expect(groupActivityBlocks([prose, reasoning, tools, prose, tools, answer])).toEqual([
      { kind: "activity", blocks: [prose, reasoning, tools, prose, tools] },
      { kind: "block", block: answer },
    ]);
  });

  it("never hides attachments or approval requests in the process", () => {
    const approval: MessageBlock = { kind: "ask", text: "Approve?" };
    expect(groupActivityBlocks([reasoning, tools, approval, prose, tools, answer])).toEqual([
      { kind: "activity", blocks: [reasoning, tools] },
      { kind: "block", block: approval },
      { kind: "activity", blocks: [prose, tools] },
      { kind: "block", block: answer },
    ]);
  });

  it("keeps ordinary multi-paragraph replies unchanged", () => {
    expect(groupActivityBlocks([prose, answer])).toEqual([
      { kind: "block", block: prose },
      { kind: "block", block: answer },
    ]);
  });
});
