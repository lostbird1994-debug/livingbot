import assert from "node:assert/strict";
import { test } from "node:test";
import { codeExport, fenceLanguage } from "./code-export.ts";

test("markup and data fences export with their real type", () => {
  assert.deepEqual(codeExport("html"), { name: "output.html", mediaType: "text/html;charset=utf-8", preview: true });
  assert.deepEqual(codeExport("svg"), { name: "output.svg", mediaType: "image/svg+xml", preview: true });
  assert.equal(codeExport("json").mediaType, "application/json;charset=utf-8");
  assert.equal(codeExport("csv").name, "output.csv");
});

test("common aliases resolve to one canonical extension", () => {
  assert.equal(codeExport("markdown").name, "output.md");
  assert.equal(codeExport("md").name, "output.md");
  assert.equal(codeExport("yml").name, "output.yaml");
  assert.equal(codeExport("bash").name, "output.sh");
  assert.equal(codeExport("python").name, "output.py");
});

test("a fence language can never become a path or an unknown type", () => {
  for (const language of ["../../etc/passwd", "text/javascript", "unknown-lang", "", "   "]) {
    const exported = codeExport(language);
    assert.equal(exported.preview, false, language);
    assert.match(exported.name, /^output\.[a-z0-9]{1,12}$/, language);
  }
  assert.equal(codeExport("../../etc/passwd").name, "output.txt");
});

test("a highlighted fence with metadata still resolves its language", () => {
  assert.equal(fenceLanguage("language-ts title=example.ts"), "ts");
  assert.equal(fenceLanguage("JSON"), "json");
  assert.equal(fenceLanguage("{.html}"), "");
});
