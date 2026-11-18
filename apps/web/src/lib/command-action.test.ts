import { describe, expect, it } from "vitest";
import { commandAction, commandTarget } from "./command-action";

describe("command action", () => {
  it("names the intent of the commands a run actually issues", () => {
    expect(commandAction("git diff --stat")).toBe("review-changes");
    expect(commandAction("git log --oneline -5")).toBe("review-history");
    expect(commandAction("ls -la")).toBe("list-files");
    expect(commandAction('cat "MEMORY.md"')).toBe("read-file");
    expect(commandAction("rg -n todo src")).toBe("search-content");
    expect(commandAction("pnpm vitest run apps/web")).toBe("run-tests");
    expect(commandAction("pnpm --filter @livingbot/web build")).toBe("build");
    expect(commandAction("pnpm install")).toBe("install");
    expect(commandAction("curl -s http://127.0.0.1:43183/health")).toBe("call-endpoint");
    expect(commandAction("python -m reportdb.cli reference-doc")).toBe("run-script");
  });

  it("reads a chain by its most specific step", () => {
    expect(commandAction('cd "/tmp/app" && ./.venv/bin/python -m tools.sync')).toBe("run-script");
    expect(commandAction("cd app && pnpm vitest run")).toBe("run-tests");
    expect(commandAction("cd app")).toBe("change-directory");
  });

  it("ignores wrappers, env prefixes and flags", () => {
    expect(commandAction("FOO=1 sudo -E ls -la")).toBe("list-files");
    expect(commandAction("/usr/bin/git status --short")).toBe("review-changes");
    expect(commandAction("time pnpm test")).toBe("run-tests");
  });

  it("leaves a command it cannot name anonymous", () => {
    expect(commandAction("kubectl get pods")).toBeUndefined();
    expect(commandAction("./run.sh")).toBeUndefined();
    expect(commandAction("")).toBeUndefined();
    expect(commandAction(undefined)).toBeUndefined();
  });
});

describe("command target", () => {
  it("names the file a read or search touched", () => {
    expect(commandTarget("cat AGENTS.md")).toBe("AGENTS.md");
    expect(commandTarget('wc -l "MEMORY.md"')).toBe("MEMORY.md");
    expect(commandTarget("rg -n todo src/agents.ts")).toBe("agents.ts");
  });

  it("names the script, endpoint, folder or destination a command works on", () => {
    expect(commandTarget("/workspace/example/.venv311/bin/python sync_records.py --month 11")).toBe(
      "sync_records.py",
    );
    expect(commandTarget("python -m reportdb.cli reference-doc")).toBe("reportdb.cli");
    expect(commandTarget("curl -s http://127.0.0.1:43183/health")).toBe("127.0.0.1:43183/health");
    expect(commandTarget("cp -r draft /tmp/out")).toBe("out");
    expect(commandTarget("cd /workspace/example")).toBe("example");
    expect(commandTarget("ls Desktop/")).toBe("Desktop");
  });

  it("ignores redirections and pipes instead of naming them", () => {
    expect(commandTarget("ls -la 2>/dev/null")).toBeUndefined();
    expect(commandTarget("cp a.csv /tmp/b.csv 2>&1")).toBe("b.csv");
    expect(commandTarget("cat report.log > /tmp/out.log")).toBe("report.log");
  });

  it("stays silent when the command names nothing worth showing", () => {
    expect(commandTarget("ls -la")).toBeUndefined();
    expect(commandTarget("git diff --stat")).toBeUndefined();
    expect(commandTarget("date")).toBeUndefined();
    expect(commandTarget(undefined)).toBeUndefined();
  });
});
