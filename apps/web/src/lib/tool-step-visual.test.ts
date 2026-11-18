import { describe, expect, it } from "vitest";
import { shortDetail, toolFamily } from "./tool-step-visual";

describe("tool family", () => {
  it("knows the tools both runtimes call", () => {
    expect(toolFamily("exec")).toBe("run");
    expect(toolFamily("read_file")).toBe("read");
    expect(toolFamily("apply_patch")).toBe("write");
    expect(toolFamily("memory_search")).toBe("search");
    expect(toolFamily("web_fetch")).toBe("browse");
  });

  it("places a tool this list never saw by what its name says", () => {
    expect(toolFamily("nightly_report_writer")).toBe("write");
    expect(toolFamily("shell_tool_v2")).toBe("run");
    expect(toolFamily("kb_lookup")).toBe("search");
    expect(toolFamily("desktop_clicker")).toBe("control");
  });

  it("keeps the plain tool icon for a name it cannot place", () => {
    expect(toolFamily("canvas")).toBe("tool");
    expect(toolFamily(undefined)).toBe("tool");
    expect(toolFamily("xqz")).toBe("tool");
  });
});

describe("a long path in a row", () => {
  it("reads as its own name", () => {
    expect(shortDetail("/workspace/example/文档/测试目录/20261118 示例清单/说明.md")).toBe(
      "说明.md",
    );
  });

  it("stays as written when it is already short", () => {
    expect(shortDetail("notes/tuesday.md")).toBe("notes/tuesday.md");
    expect(shortDetail("AGENTS.md")).toBe("AGENTS.md");
  });
});
