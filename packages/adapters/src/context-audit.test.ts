import { describe, expect, it, vi } from "vitest";
import { contextAuditTools, maybeOfferContextAudit } from "./context-audit.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const scope = { spaceId: "space", userId: "owner", botId: "bot" };
const now = new Date("2026-11-16T10:00:00Z");
function fixture(count = 50) {
  let pending: { id: string } | null = null;
  const routine = {
    id: "audit",
    ...scope,
    usageTrigger: { kind: "human-messages", count: 50, action: "ask" },
    usageSince: new Date("2026-11-15T00:00:00Z") as Date | null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    bot: { findFirst: vi.fn().mockResolvedValue({ thread: { id: "thread" } }) },
    run: {
      findFirst: vi.fn().mockImplementation(async () => pending),
      create: vi.fn().mockImplementation(async () => {
        pending = { id: "audit-run" };
        return pending;
      }),
      findUnique: vi.fn().mockResolvedValue({ status: "waiting_input", firstResponseAt: now }),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task" }) },
    routine: {
      updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
        if (where.usageSince?.getTime() !== routine.usageSince?.getTime()) return { count: 0 };
        routine.usageSince = data.usageSince;
        return { count: 1 };
      }),
    },
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 2, nextEventSeq: 2 }) },
    message: { create: vi.fn().mockResolvedValue({ id: "ask" }) },
    event: { create: vi.fn().mockImplementation(async ({ data }) => data) },
  };
  const db = {
    routine: { findFirst: vi.fn().mockResolvedValue(routine), updateMany: tx.routine.updateMany },
    run: {
      findMany: vi
        .fn()
        .mockResolvedValue(Array.from({ length: count }, (_, i) => ({ sourceMessageId: `m${i}` }))),
    },
    $transaction: vi.fn().mockImplementation(async (fn) => fn(tx)),
  };
  const deps = { prisma: db, events: { notify: vi.fn() } };
  return { deps, db, tx, routine };
}
describe("usage-triggered context audit", () => {
  it("does not remind at 49 and requires no model for counting", async () => {
    const f = fixture(49);
    expect(await maybeOfferContextAudit(f.deps as never, scope, now)).toBe(false);
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ["sourceMessageId"],
        take: 50,
        where: expect.objectContaining({
          ...scope,
          trigger: { in: ["user", "follow_up"] },
          sourceMessage: { role: "user", createdAt: { gt: f.routine.usageSince, lte: now } },
        }),
      }),
    );
  });
  it("saves one owner-only question at 50 and does not duplicate a pending reminder", async () => {
    const f = fixture();
    expect(await maybeOfferContextAudit(f.deps as never, scope, now)).toBe(true);
    expect(f.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "waiting_input", routineId: "audit" }),
      }),
    );
    expect(f.tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              contextAudit: true,
              ownerOnly: true,
              actions: [
                { id: "start", label: "开始审计" },
                { id: "skip", label: "暂不" },
              ],
            }),
          ],
        }),
      }),
    );
    expect(
      await maybeOfferContextAudit(f.deps as never, scope, new Date(now.getTime() + 1000)),
    ).toBe(false);
    expect(f.tx.run.create).toHaveBeenCalledOnce();
    expect(f.deps.events.notify).toHaveBeenCalledOnce();
  });
  it("ignores disabled routines and starts a missing baseline without retroactive counting", async () => {
    const f = fixture();
    f.db.routine.findFirst.mockResolvedValueOnce(null);
    expect(await maybeOfferContextAudit(f.deps as never, scope, now)).toBe(false);
    expect(f.db.run.findMany).not.toHaveBeenCalled();
    f.routine.usageSince = null;
    expect(await maybeOfferContextAudit(f.deps as never, scope, now)).toBe(false);
    expect(f.db.run.findMany).not.toHaveBeenCalled();
  });
  it("limits audit tools to reads and keeps its loading-preview tool out of ordinary runs", () => {
    const options = {
      graphicalToolsAllowed: true,
      groupId: null,
      trigger: "routine",
      semanticMemoryEnabled: true,
      messagingChannelRun: false,
    };
    const names = selectBuiltinToolsForRun({ ...options, contextAudit: true }).map(
      (tool) => tool.name,
    );
    expect(names).toContain("read_loaded_context");
    expect(names).toContain("skill_read");
    expect(names).toContain("read_file");
    for (const name of [
      "write_memory",
      "remember",
      "save_shared_memory",
      "shell",
      "write_file",
      "web_fetch",
      "schedule_create",
      "ask_user",
      "message_user",
    ])
      expect(names).not.toContain(name);
    expect(selectBuiltinToolsForRun(options).map((tool) => tool.name)).not.toContain(
      "read_loaded_context",
    );
  });
  it("pages the exact native preview without refreshing or writing source files", async () => {
    const native = {
      documents: [
        {
          scope: "bot",
          name: "AGENTS.md",
          content: "x".repeat(6000),
          excerpt: "loaded excerpt",
          totalChars: 6000,
          shownChars: 14,
        },
      ],
      budgets: { document: 12000, total: 60000 },
    };
    const preview = vi.fn().mockResolvedValue(native);
    const refresh = vi.fn();
    const ctx = {
      source: { contextAudit: true },
      run: scope,
      bot: { id: "bot" },
      context: { signal: new AbortController().signal },
      secrets: [],
      deps: {
        prisma: {
          bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot" }) },
          scratchpadItem: { findMany: vi.fn().mockResolvedValue([]) },
        },
        nativeContextPreview: preview,
        botWorkspace: { refresh },
      },
    } as unknown as RunContext;
    const call = (offset: number) =>
      ({ args: { offset }, finish: async (result: unknown) => result }) as unknown as ToolCall;
    const first = (await contextAuditTools.read_loaded_context!(ctx, call(0))) as {
      content: string;
      next_offset: number;
    };
    const second = (await contextAuditTools.read_loaded_context!(ctx, call(first.next_offset))) as {
      content: string;
    };
    expect(JSON.parse(first.content + second.content).nativeContext).toEqual(native);
    expect(preview).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
});

it("restricts workspace organization to local file maintenance tools", () => {
  const names = selectBuiltinToolsForRun({
    graphicalToolsAllowed: true,
    groupId: null,
    trigger: "routine",
    semanticMemoryEnabled: true,
    messagingChannelRun: false,
    workspaceOrganization: true,
  }).map((tool) => tool.name);
  for (const name of ["read_file", "list_files", "write_file", "shell"])
    expect(names).toContain(name);
  for (const name of [
    "message_user",
    "message_bot",
    "write_memory",
    "organize_memory",
    "update_bot",
    "schedule_create",
    "web_fetch",
  ])
    expect(names).not.toContain(name);
});
