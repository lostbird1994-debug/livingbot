import type { MessageBlock } from "@livingbot/contracts";
import { describe, expect, it } from "vitest";
import { groupActivityBlocks } from "./activity-timeline";

describe("execution process boundaries", () => {
  const reasoning: MessageBlock = { kind: "reasoning", text: "Think" };
  const tools: MessageBlock = { kind: "steps", steps: [{ label: "Read", count: 1 }] };
  const prose: MessageBlock = { kind: "text", text: "Inspect." };
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


it("preserves a substantive body and the latest answer around resumed tools", () => {
  const report: MessageBlock = { kind: "text", text: "A detailed completed report with substantial reader content." };
  const tool: MessageBlock = { kind: "steps", steps: [{ label: "Read", count: 1 }] };
  const answer: MessageBlock = { kind: "text", text: "The answer to the new question." };
  expect(groupActivityBlocks([report, tool, answer, tool])).toEqual([
    { kind: "block", block: report }, { kind: "activity", blocks: [tool] },
    { kind: "block", block: answer }, { kind: "activity", blocks: [tool] },
  ]);
});

it("never folds a backend-owned interactive preview into tool activity", () => {
  const tool: MessageBlock = {kind:"steps",steps:[{label:"Read",count:1}]};
  const preview: MessageBlock = {kind:"text",text:"Preview",preview:{blockId:"widget:cv_example",title:"Preview"}};
  expect(groupActivityBlocks([tool,preview,tool])).toEqual([
    {kind:"activity",blocks:[tool]},{kind:"block",block:preview},{kind:"activity",blocks:[tool]},
  ]);
});
