import { describe, expect, it } from "vitest";
import { localDocumentPath, localDocumentReferences } from "./local-file-reference.js";

describe("local document references", () => {
  it.each([
    ["MEDIA:/Users/test/财务 报告.docx", "/Users/test/财务 报告.docx"],
    ["`/Users/test/费用（本月）.xlsx`", "/Users/test/费用（本月）.xlsx"],
    ["[报告](</Users/test/my report.pdf>)", "/Users/test/my report.pdf"],
    ["file:///Users/test/my%20report.docx", "/Users/test/my report.docx"],
    ["~/Desktop/report.md", "~/Desktop/report.md"],
  ])("recognizes %s", (text, path) => {
    expect(localDocumentReferences(text).map((reference) => reference.path)).toEqual([path]);
  });

  it("keeps separate files and surrounding prose", () => {
    const text = "文件 /Users/test/a.docx 和 /Users/test/b.xlsx。";
    const refs = localDocumentReferences(text);
    expect(refs.map((ref) => ref.path)).toEqual(["/Users/test/a.docx", "/Users/test/b.xlsx"]);
    expect(text.slice(refs[0]!.start, refs[0]!.end)).toBe("/Users/test/a.docx");
  });

  it.each([
    "https://example.com/Users/test/a.docx",
    "/Users/test/run.command",
    "/Users/test/tool.app",
    "file://another-host/a.docx",
    "javascript:alert(1)",
    "/Users/test/a\n.docx",
  ])("rejects URLs, executables, and malformed paths: %s", (path) => {
    expect(localDocumentPath(path)).toBeUndefined();
    expect(localDocumentReferences(path)).toEqual([]);
  });
});
