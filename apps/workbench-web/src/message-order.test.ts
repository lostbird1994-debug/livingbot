import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../../packages/workbench/src/contracts.ts";
import { orderMessages } from "./message-order.ts";

function message(id: string, createdAt: number, role: Message["role"]): Message {
  return { id, createdAt, updatedAt: createdAt, role, conversationId: "conversation", blocks: [], final: true };
}

test("an input that shares a millisecond still precedes its reply", () => {
  const order = orderMessages([message("engine:run-1", 1_000, "assistant"), message("input:submission-1", 1_000, "user")]);
  assert.deepEqual(order.map((item) => item.role), ["user", "assistant"]);
});

test("later work keeps its chronological place", () => {
  const order = orderMessages([
    message("second", 2_000, "assistant"), message("third", 3_000, "user"), message("first", 1_000, "user"),
  ]);
  assert.deepEqual(order.map((item) => item.id), ["first", "second", "third"]);
});

test("ties among replies stay deterministic", () => {
  const order = orderMessages([message("b", 5, "assistant"), message("a", 5, "assistant")]);
  assert.deepEqual(order.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(orderMessages([...order]).map((item) => item.id), ["a", "b"]);
});
