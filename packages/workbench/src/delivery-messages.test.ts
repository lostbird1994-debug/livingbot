import assert from "node:assert/strict";
import test from "node:test";
import { deliveredMessages } from "./delivery-messages.ts";
import type { Message } from "./contracts.ts";

test("legacy delivery merges only into its canonical run reply, leaving interim answers and other owners intact", () => {
  const base: Message = { id: "engine:run", role: "assistant", botId: "bot", conversationId: "chat", taskId: "task", runId: "run", blocks: [{ id: "text", kind: "text", text: "Final report" }], final: true, createdAt: 1, updatedAt: 1 };
  const legacy: Message = { ...base, id: "file:artifact:chat", blocks: [{ id: "file", kind: "file", artifactId: "artifact", name: "report.txt", mediaType: "text/plain" }] };
  const question = { ...base, id: "interim", blocks: [{ id: "answer", kind: "text" as const, text: "Working" }] };
  const projected = deliveredMessages([question, base, legacy, { ...legacy, id: "file:other:chat", runId: "other" }], []);
  assert.equal(projected.length, 3);
  assert.equal(projected[0].blocks.length, 1);
  assert.deepEqual(projected[1].blocks.map((block) => block.kind), ["text", "file"]);
  assert.equal(base.blocks.length, 1);
  assert.equal(projected[2].id, "file:other:chat");
});
