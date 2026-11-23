import assert from "node:assert/strict";
import test from "node:test";
import { readInteractionDraft, saveInteractionDraft } from "./interaction-draft.ts";

test("a reloaded tab retains the exact answer identity and mixed question draft", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const draft = {
      answers: { target: ["local"], outputs: ["summary", "Chinese custom answer"] },
      other: { outputs: "Chinese custom answer" },
      pendingAnswer: { resolutionId: "same-resolution", decision: "allow-once" as const },
    };
    saveInteractionDraft("approval:one", draft);
    assert.deepEqual(readInteractionDraft("approval:one"), draft);
    assert.equal(readInteractionDraft("approval:other"), undefined);
    saveInteractionDraft("approval:one", { answers: draft.answers, other: draft.other });
    assert.equal(readInteractionDraft("approval:one")?.pendingAnswer, undefined);
    values.set("livingbot:interaction:invalid", '{"version":1,"answers":{"x":[1]},"other":{}}');
    assert.equal(readInteractionDraft("invalid"), undefined);
  } finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
});

test("unavailable session storage preserves the ordinary in-memory UI path", () => {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("Storage disabled"); } });
  try {
    assert.equal(readInteractionDraft("one"), undefined);
    assert.doesNotThrow(() => saveInteractionDraft("one", { answers: {}, other: {} }));
  } finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
});
