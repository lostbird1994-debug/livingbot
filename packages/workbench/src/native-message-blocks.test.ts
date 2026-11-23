import assert from "node:assert/strict";
import test from "node:test";
import { nativeMessageBlocks, mergeNativeMessage } from "./native-message-blocks.ts";
import type { Block } from "./contracts.ts";

test("durable native boundaries recover thinking, tools and text without wording-based deduplication", () => {
  const earlier = nativeMessageBlocks({ __openclaw: { seq: 2 }, content: [
    { type: "thinking", thinking: "Same" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { description: "Read source" } },
  ] }, "native-1");
  const later = nativeMessageBlocks({ __openclaw: { seq: 4 }, content: [
    { type: "thinking", thinking: "Same" }, { type: "text", text: "Reply" },
  ] }, "native-2");
  const live: Block[] = [{ id: "live-thinking", kind: "reasoning", text: "S" },
    { id: "tool:tool-1", kind: "tool", name: "read", title: "Read source", phase: "result" }];
  const recovered = mergeNativeMessage(mergeNativeMessage(live, earlier), later);
  assert.deepEqual(recovered.map((block) => block.kind), ["reasoning", "tool", "reasoning", "text"]);
  assert.equal(recovered[1].kind === "tool" && recovered[1].phase, "result");
  assert.deepEqual(mergeNativeMessage(mergeNativeMessage(recovered, later), earlier), recovered);
});
