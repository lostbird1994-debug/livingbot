import assert from "node:assert/strict";
import { test } from "node:test";
import { registerVisualGuidelines, visualGuidelines, visualModules } from "./visual-guidelines.mjs";

test("visual guide protocol accepts arrays, encoded arrays and module lists without unknown modules", () => {
  assert.deepEqual(visualModules(["interactive", "diagram", "diagram"]), [
    "diagram",
    "interactive",
  ]);
  assert.deepEqual(visualModules('["diagram","interactive"]'), ["diagram", "interactive"]);
  assert.deepEqual(visualModules("diagram, interactive"), ["diagram", "interactive"]);
  assert.throws(() => visualModules(["unknown"]));
});

test("native diagram guidance works offline without private guide resources", async () => {
  let tool;
  registerVisualGuidelines({
    registerTool(value) {
      tool = value;
    },
  });
  assert.equal(tool.name, "widget_guidelines");
  const result = await tool.execute("test", { modules: ["diagram"] });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.type, "visualizer_read_me_result");
  assert.equal(payload.content, await visualGuidelines(["diagram"]));
  assert.ok(payload.content.length > 100);
});
