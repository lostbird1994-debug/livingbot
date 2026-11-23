import assert from "node:assert/strict";
import test from "node:test";
import { nativeWidgets } from "./widgets.ts";

test("native inline references retain session ownership and deduplicate documents", () => {
  const canvas = { type: "canvas", preview: {
    kind: "canvas", surface: "assistant_message", viewId: "cv_example-123", title: "交互图",
  } };
  assert.deepEqual(nativeWidgets({ content: [canvas, canvas] }, "agent:atlas:private"), [{
    id: "widget:cv_example-123", kind: "widget", docId: "cv_example-123",
    title: "交互图", sessionKey: "agent:atlas:private",
  }]);
});

test("URLs, node panels, MCP applications and malformed document handles are not inline HTML documents", () => {
  const preview = { kind: "canvas", surface: "assistant_message", viewId: "cv_example" };
  assert.deepEqual(nativeWidgets({ content: [
    { type: "canvas", preview: { ...preview, surface: "node_panel" } },
    { type: "canvas", preview: { ...preview, viewId: "../../private" } },
    { type: "canvas", preview: { ...preview, viewId: undefined, url: "https://example.com" } },
    { type: "canvas", preview: { ...preview, mcpApp: { viewId: "cv_example" } } },
    { type: "text", text: JSON.stringify(preview) },
    null,
  ] }, "session"), []);
});
