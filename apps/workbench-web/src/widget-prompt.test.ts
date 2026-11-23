import assert from "node:assert/strict";
import test from "node:test";
import { readWidgetPrompt, saveWidgetPrompt } from "./widget-prompt.ts";

test("an uncertain widget send retains its exact identity across remount and remains scoped to its saved document", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const input = { submissionId: "same-input", message: "请继续解释这张图。" };
    saveWidgetPrompt("saved-one", input);
    assert.deepEqual(readWidgetPrompt("saved-one"), input);
    assert.equal(readWidgetPrompt("saved-two"), undefined);
    saveWidgetPrompt("saved-one");
    assert.equal(readWidgetPrompt("saved-one"), undefined);
    values.set("livingbot:widget-prompt:invalid", '{"version":1,"submissionId":1,"message":"invalid"}');
    assert.equal(readWidgetPrompt("invalid"), undefined);
  } finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
});

test("unavailable browser storage does not block the mounted widget sending path", () => {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("Unavailable"); } });
  try {
    assert.equal(readWidgetPrompt("one"), undefined);
    assert.doesNotThrow(() => saveWidgetPrompt("one", { submissionId: "one", message: "example" }));
  } finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
});
