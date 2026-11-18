import { describe, expect, it } from "vitest";
import { describeToolActivity, toolCallAction, toolCallTarget } from "./tool-activity-text.js";

describe("toolCallTarget", () => {
  it("names the file a read or write touched", () => {
    expect(toolCallTarget("read_file", { path: "notes/plan.md" })).toBe("notes/plan.md");
    expect(toolCallTarget("write_memory", { path: "MEMORY.md" })).toBe("MEMORY.md");
    expect(toolCallTarget("save_shared_memory", { path: "shared/team.md" })).toBe("shared/team.md");
  });

  it("names the command, query or page a call used", () => {
    expect(toolCallTarget("shell", { command: "pnpm test --filter web" })).toBe(
      "pnpm test --filter web",
    );
    expect(toolCallTarget("web_search", { query: "rakazo agents" })).toBe("rakazo agents");
    expect(toolCallTarget("web_fetch", { url: "https://example.com/a?b=c#d" })).toBe(
      "https://example.com/a",
    );
  });

  it("defaults the directory a bare listing reads", () => {
    expect(toolCallTarget("list_files", {})).toBe(".");
  });

  it("unwraps a builtin tool the model called by name", () => {
    expect(toolCallTarget("use_tool", { name: "read_file", arguments: { path: "a.ts" } })).toBe(
      "a.ts",
    );
  });

  it("names a connector's tool server and method", () => {
    expect(toolCallTarget("mcp__brex__list_expenses", {})).toBe("brex · list_expenses");
  });

  it("has no target for tools that act on nothing nameable", () => {
    expect(toolCallTarget("render_plot", { spec: {} })).toBeUndefined();
    expect(toolCallTarget("find_tool", { query: "calendar" })).toBeUndefined();
    expect(toolCallTarget("browser_snapshot", {})).toBeUndefined();
  });

  it("keeps a target short and free of credentials", () => {
    const long = toolCallTarget("shell", { command: `a\n\t${"x".repeat(200)}` });
    expect(long).toHaveLength(91);
    expect(long?.endsWith("…")).toBe(true);
    expect(toolCallTarget("shell", { command: "export API_KEY=sk-secretvalue" })).toBe(
      "export API_KEY=[redacted]",
    );
  });
});

describe("runtime tool names", () => {
  it("names the command an OpenClaw exec runs", () => {
    expect(toolCallTarget("exec", { command: "node patch.mjs --dry", workdir: "/tmp" })).toBe(
      "node patch.mjs --dry",
    );
    expect(describeToolActivity("exec", { command: "node patch.mjs --dry" })).toBe(
      "Running: node patch.mjs --dry",
    );
  });

  it("names the file a patch touches", () => {
    const input = "*** Begin Patch\n*** Update File: notes/plan.md\n@@\n-a\n+b\n*** End Patch";
    expect(toolCallTarget("apply_patch", { input })).toBe("notes/plan.md");
    expect(describeToolActivity("apply_patch", { input })).toBe("Editing notes/plan.md");
  });

  it("reads the memory and search tools this runtime ships", () => {
    expect(toolCallTarget("memory_search", { query: "invoice" })).toBe("invoice");
    expect(toolCallTarget("memory_get", { path: "MEMORY.md" })).toBe("MEMORY.md");
    expect(describeToolActivity("memory_search", { query: "invoice" })).toBe(
      "Searching memory: invoice",
    );
  });

  it("falls back to the field an unknown tool describes itself with", () => {
    expect(toolCallTarget("future_tool", { path: "a/b.ts" })).toBe("a/b.ts");
    expect(toolCallTarget("future_tool", { content: "unbounded text" })).toBeUndefined();
    expect(describeToolActivity("future_tool", { path: "a/b.ts" })).toBe(
      "Using future_tool: a/b.ts",
    );
  });

  it("says what a session or scheduling tool is doing without naming a target", () => {
    expect(describeToolActivity("sessions_spawn", { task: "long brief" })).toBe(
      "Starting a helper",
    );
    expect(describeToolActivity("cron", {})).toBe("Scheduling a job");
  });
});

describe("toolCallAction", () => {
  it("returns the intent the tool asked the model to write", () => {
    expect(toolCallAction("exec", { command: "ls -la", description: "列出当前目录" })).toBe(
      "列出当前目录",
    );
  });

  it("has nothing to say when the call did not state one", () => {
    expect(toolCallAction("exec", { command: "ls -la" })).toBeUndefined();
    expect(toolCallAction("exec", { command: "ls", description: "   " })).toBeUndefined();
    expect(toolCallAction("read_file", { path: "a.ts" })).toBeUndefined();
  });

  it("keeps a stated intent short and free of credentials", () => {
    const long = toolCallAction("exec", { command: "x", description: "y".repeat(200) });
    expect(long).toHaveLength(91);
    expect(toolCallAction("exec", { command: "x", description: "export TOKEN=sk-secret" })).toBe(
      "export TOKEN=[redacted]",
    );
  });
});
