import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { watchResultNotifications } from "./result-events.mjs";

const { resultNotifications } = createRequire(import.meta.url)("./notifications.cjs");

function fixture() {
  const created = [];
  const actions = [];
  let focused = false;
  let supported = true;
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; created.push(this); }
    show() { actions.push("notify"); }
    close() { actions.push("close"); this.emit("close"); }
  }
  const window = {
    isDestroyed: () => false, isFocused: () => focused, isMinimized: () => true,
    restore: () => actions.push("restore"), show: () => actions.push("show"),
    focus: () => actions.push("focus"),
  };
  const controller = resultNotifications({
    Notification, getWindow: () => window, openResult: (id) => actions.push(id),
  });
  return { controller, created, actions, focus: (value) => { focused = value; },
    support: (value) => { supported = value; } };
}

test("committed result produces one desktop alert and its click opens the exact report", () => {
  const store = new WorkbenchStore(":memory:");
  const native = fixture();
  const notice = {
    id: "result-moss", taskId: "task-moss", runId: "run-moss", botId: "moss",
    conversationId: "private-moss", messageId: "message-moss",
    outcome: "completed", createdAt: 1,
  };
  // Existing history is visible in-app, without an alert on startup.
  store.put("notifications", { ...notice, id: "old-result" });
  store.put("bots", { id: "moss", name: "Moss" });
  const detach = watchResultNotifications(store, (result) => native.controller.receive(result));
  try {
    store.put("notifications", notice);
    store.put("notifications", notice);
    store.put("notifications", { ...notice, readAt: 2 });
    assert.equal(native.created.length, 1);
    assert.deepEqual(native.created[0].options, { title: "LivingBot 2", body: "Moss：工作已完成" });
    native.created[0].emit("click");
    assert.deepEqual(native.actions, ["notify", "restore", "show", "focus", "result-moss"]);
    native.controller.close();
    assert.equal(native.actions.at(-1), "close");
    detach();
    store.put("notifications", { ...notice, id: "detached-result" });
    assert.equal(native.created.length, 1);
  } finally { detach(); store.close(); }
});

test("focused application and unsupported native notifications retain in-app delivery only", () => {
  const native = fixture();
  native.focus(true);
  native.controller.receive({ id: "focused", name: "Moss", outcome: "completed" });
  native.focus(false);
  native.controller.receive({ id: "focused", name: "Moss", outcome: "completed" });
  native.support(false);
  native.controller.receive({ id: "unsupported", name: "Moss", outcome: "completed" });
  assert.equal(native.created.length, 0);
});

test("failed work has a distinct alert and native failure releases its notification", () => {
  const native = fixture();
  native.controller.receive({ id: "failed", name: "Fern", outcome: "failed" });
  assert.equal(native.created[0].options.body, "Fern：工作未完成");
  native.created[0].emit("failed", {}, "Notifications unavailable");
  native.controller.close();
  assert.deepEqual(native.actions, ["notify"]);
});
