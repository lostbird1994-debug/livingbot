import assert from "node:assert/strict";
import { test } from "node:test";
import { blockCost, computeSegments, mergeNarration, processSummary, processView, reasoningComplete, reasoningOpen, replyLive, segmentOpen, stepLive, visibleStart } from "./reply-state.ts";
import type { Block } from "../../../packages/workbench/src/contracts.ts";

test("a running reply opens its process and names the live state", () => {
  for (const activity of ["queued", "running", "waiting"] as const) {
    assert.deepEqual(processView(false, activity), { open: true, label: "正在工作" });
  }
  assert.deepEqual(processView(false, "stopping"), { open: true, label: "正在停止" });
});

test("an unfinished reply never claims work after its task ended", () => {
  assert.deepEqual(processView(false, "interrupted"), { open: false, label: "执行已中断" });
  assert.deepEqual(processView(false, "cancelled"), { open: false, label: "已停止" });
  assert.deepEqual(processView(false, "failed"), { open: false, label: "执行失败" });
});

test("unknown or background-only ownership stays explicitly unconfirmed", () => {
  assert.deepEqual(processView(false), { open: false, label: "结果未确认" });
  assert.deepEqual(processView(false, "background"), { open: false, label: "结果未确认" });
  assert.deepEqual(processView(false, "unconfirmed"), { open: false, label: "结果未确认" });
  assert.deepEqual(processView(false, "completed"), { open: false, label: "结果未完整保存" });
});

test("a final reply always folds its process, whatever the task state is", () => {
  for (const activity of ["running", "failed", "cancelled", undefined] as const) {
    assert.deepEqual(processView(true, activity), { open: false, label: "执行过程" });
  }
});

test("only the latest reasoning stage of live work opens itself", () => {
  assert.equal(reasoningOpen(true, 1, 2), true);
  assert.equal(reasoningOpen(true, 0, 2), false);
  assert.equal(reasoningOpen(false, 1, 2), false);
});

test("consecutive narration merges into one block, tools and reasoning stay separate", () => {
  const merged = mergeNarration([
    { id: "a", kind: "text", text: "先看目录" },
    { id: "b", kind: "text", text: "再看表格" },
    { id: "t", kind: "tool", name: "read", title: "读取", phase: "start" },
    { id: "c", kind: "text", text: "读完" },
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0]!.kind === "text" && merged[0]!.text, "先看目录\n\n再看表格");
  assert.equal(merged[1]!.kind, "tool");
});

test("the folded summary counts real tool calls and narration, ignoring dispatch wrappers", () => {
  assert.equal(processSummary([
    { id: "1", kind: "tool", name: "read", title: "读取", phase: "start" },
    { id: "2", kind: "tool", name: "dispatch_action", title: "派发", phase: "start" },
    { id: "3", kind: "text", text: "一句话" },
  ]), "1 项操作 · 1 段说明");
  assert.equal(processSummary([{ id: "1", kind: "reasoning", text: "想一下" }]), "");
});

const reasoning = (id: string, text = "想一下"): Block => ({ id, kind: "reasoning", text });
const tool = (id: string, title = "读取文件", detail?: string): Block => ({ id, kind: "tool", name: "read", title, phase: "start", detail });
const say = (id: string, text: string): Block => ({ id, kind: "text", text });

test("consecutive steps group, a sentence between them splits the groups", () => {
  const segments = computeSegments([
    reasoning("r1"), tool("t1"), tool("t2"),
    say("s1", "先说一句"),
    tool("t3"), reasoning("r2"),
  ]);
  assert.deepEqual(segments.map((segment) => segment.kind), ["group", "block", "group"]);
  assert.equal(segments[0]!.kind === "group" && segments[0]!.blocks.length, 3);
  assert.equal(segments[2]!.kind === "group" && segments[2]!.blocks.length, 2);
});

test("one step alone is not a group, and narration never folds", () => {
  const segments = computeSegments([say("s1", "开始"), tool("t1"), say("s2", "结束")]);
  assert.deepEqual(segments.map((segment) => segment.kind), ["block", "block", "block"]);
  assert.equal(segments.every((segment) => segment.kind !== "group"), true);
});

test("a finished reasoning stage closes while the active one stays open", () => {
  assert.equal(reasoningComplete(false, 0, 2), true);
  assert.equal(reasoningComplete(true, 0, 2), true);
  assert.equal(reasoningComplete(true, 1, 2), false);
  // A final reply is never live, so every stage counts as finished.
  assert.equal(reasoningComplete(false, 1, 1), true);
});

test("only the live tail segment opens itself", () => {
  const segments = computeSegments([tool("t1"), tool("t2"), say("s1", "一句"), tool("t3"), tool("t4")]);
  assert.equal(segmentOpen(segments[0]!, 0, segments.length, true), false);
  assert.equal(segmentOpen(segments[0]!, 0, segments.length, false), false);
  assert.equal(segmentOpen(segments[2]!, 2, segments.length, true), true);
  assert.equal(segmentOpen(segments[2]!, 2, segments.length, false), false);
});

test("the fold budget keeps the newest items and never hides an oversized last one", () => {
  const small = Array.from({ length: 40 }, () => 10);
  // 15 items per batch, taken from the end.
  assert.equal(visibleStart(small), 25);
  assert.equal(visibleStart(small, 15, 24_576), 25);
  // Character budget binds before the item count does.
  // 24576 / 5000 = 4 items fit; the fifth would exceed the budget.
  assert.equal(visibleStart([5_000, 5_000, 5_000, 5_000, 5_000, 5_000]), 2);
  // A single oversized item still shows.
  assert.equal(visibleStart([40_000]), 0);
  assert.equal(visibleStart([]), 0);
});

test("block cost counts the text a reader would have to render", () => {
  assert.equal(blockCost(reasoning("r", "12345")), 5);
  assert.equal(blockCost(tool("t", "读取文件", "detail")), 4 + 6);
  assert.equal(blockCost(say("s", "一二三")), 3);
});

test("a reply is live only while its own task can still act", () => {
  assert.equal(replyLive(false, "running"), true);
  assert.equal(replyLive(false, "queued"), true);
  assert.equal(replyLive(false, "stopping"), true);
  assert.equal(replyLive(false, "failed"), false);
  assert.equal(replyLive(false, "interrupted"), false);
  assert.equal(replyLive(false, "cancelled"), false);
  assert.equal(replyLive(true, "running"), false);
  assert.equal(replyLive(true, undefined), false);
});

test("only the last step of a group is active", () => {
  assert.equal(stepLive(true, 2, 3), true);
  assert.equal(stepLive(true, 0, 3), false);
  assert.equal(stepLive(false, 2, 3), false);
});
