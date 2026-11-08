import { describe, expect, it, vi } from "vitest";
import { configureMemoryMaintenance, renderMemoryProposal } from "./memory-maintenance.js";
import type { RunContext } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const source = {
  id: "doc",
  path: "MEMORY.md",
  content: `# Summary\nCurrent rule\nOld detail\n${"More old detail ".repeat(60)}`,
  revision: 7,
};
describe("memory maintenance proposals", () => {
  it("retains exact source text, a versioned reference and the complete preimage", () => {
    const result = renderMemoryProposal(source, {
      path: source.path,
      expected_revision: 7,
      keep_ranges: [{ start_line: 1, end_line: 2 }],
    });
    expect(result.path).toBe("memory/reviews/doc.v7.md");
    expect(result.content).toContain("bot:MEMORY.md@v7#L1-L2");
    expect(result.content).toContain("> # Summary\n> Current rule");
    expect(result.content).toContain("> Old detail\n> More old detail");
    expect(source.content).toBe(
      `# Summary\nCurrent rule\nOld detail\n${"More old detail ".repeat(60)}`,
    );
  });
  it("rejects line-count reductions that save too few actual Unicode characters", () => {
    const tiny = { ...source, content: "# Summary\nKeep\n\n\n" };
    expect(() =>
      renderMemoryProposal(tiny, {
        path: tiny.path,
        expected_revision: tiny.revision,
        keep_ranges: [{ start_line: 1, end_line: 2 }],
      }),
    ).toThrow(/at least 512 characters/);
    const emoji = { ...source, content: `Keep\n${"🙂".repeat(300)}` };
    expect(() =>
      renderMemoryProposal(emoji, {
        path: emoji.path,
        expected_revision: emoji.revision,
        keep_ranges: [{ start_line: 1, end_line: 1 }],
      }),
    ).toThrow(/at least 512 characters/);
  });
  it.each([
    [{ start_line: 3, end_line: 2 }],
    [{ start_line: 1, end_line: 5 }],
    [
      { start_line: 1, end_line: 2 },
      { start_line: 2, end_line: 3 },
    ],
    [{ start_line: 1, end_line: 4 }],
  ])("rejects invalid or ineffective ranges: %j", (keep_ranges) => {
    expect(() =>
      renderMemoryProposal(source, {
        path: source.path,
        expected_revision: 7,
        keep_ranges,
      }),
    ).toThrow();
  });
  it("rejects a stale source revision", () => {
    expect(() =>
      renderMemoryProposal(source, {
        path: source.path,
        expected_revision: 6,
        keep_ranges: [{ start_line: 1, end_line: 2 }],
      }),
    ).toThrow(/Source changed/);
  });
  it("only offers the restricted maintenance tools", () => {
    const tools = selectBuiltinToolsForRun({
      graphicalToolsAllowed: true,
      groupId: null,
      trigger: "routine",
      semanticMemoryEnabled: true,
      messagingChannelRun: false,
      memoryMaintenance: true,
    });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "organize_memory",
      "propose_memory_consolidation",
      "read_memory",
      "search_memory",
    ]);
  });
  it.each(["write_memory", "save_shared_memory", "shell", "run_subagent", "use_tool"])(
    "refuses direct execution of %s before effects or approval",
    async (name) => {
      await expect(
        gateToolCall(
          { source: { memoryMaintenance: true } } as RunContext,
          { name } as ToolRequest,
          undefined,
        ),
      ).resolves.toMatchObject({ result: { error: expect.any(String) } });
    },
  );
  it("starts once on enablement, then schedules local 18:00 without reactivating paused routines", async () => {
    const upsert = vi.fn();
    const prisma = {
      bot: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a", spaceId: "s", userId: "u", disabledBuiltinTools: [] },
          { id: "b", spaceId: "s", userId: "u", disabledBuiltinTools: [] },
        ]),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }) },
      routine: {
        findUnique: vi.fn().mockResolvedValueOnce({ id: "existing" }).mockResolvedValueOnce(null),
        upsert,
      },
    };
    expect(
      await configureMemoryMaintenance(prisma as never, true, new Date("2026-11-07T18:00:00Z")),
    ).toMatchObject({ created: 1 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          memoryMaintenance: true,
          notify: false,
          crons: ["0 18 * * *"],
          timezone: "Asia/Shanghai",
          nextRunAt: new Date("2026-11-07T18:00:00Z"),
        }),
        update: {},
      }),
    );
  });
});
