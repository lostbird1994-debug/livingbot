import { BUILTIN_ROUTINES } from "@livingbot/core";
import { expect, it, vi } from "vitest";
import { ensureBuiltinRoutines } from "./builtin-routines.js";

it("creates built-ins with their product defaults, and never changes an existing toggle", async () => {
  const upsert = vi.fn();
  const db = {
    routine: { findFirst: vi.fn().mockResolvedValue(null), upsert },
    user: { findUnique: vi.fn().mockResolvedValue({ timezone: "Asia/Tokyo" }) },
  };
  await ensureBuiltinRoutines(db as never, { spaceId: "space", userId: "user" } as never, "bot");
  expect(upsert).toHaveBeenCalledTimes(4);
  for (const [args] of upsert.mock.calls) {
    expect(args.create).toMatchObject({
      active: args.create.builtinKind === "context-audit",
      notify: false,
      timezone: "Asia/Tokyo",
      botId: "bot",
    });
    if (args.create.builtinKind === "context-audit")
      expect(args.create.usageSince).toBeInstanceOf(Date);
    expect(args.update).not.toHaveProperty("active");
    expect(args.update).not.toHaveProperty("nextRunAt");
    expect(args.update).not.toHaveProperty("crons");
  }
});
it("does not repeatedly rewrite current built-ins and change shared-owner timestamps", async () => {
  const upsert = vi.fn();
  const db = {
    routine: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => ({
        id: "existing",
        ...BUILTIN_ROUTINES.find((d) => d.kind === where.builtinKind),
        builtinKind: where.builtinKind,
        crons: BUILTIN_ROUTINES.find((d) => d.kind === where.builtinKind)?.cron
          ? [BUILTIN_ROUTINES.find((d) => d.kind === where.builtinKind)!.cron]
          : [],
        timezone: "UTC",
        active: false,
        notify: false,
        requireOutput: where.builtinKind === "context-audit",
      })),
      upsert,
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  await ensureBuiltinRoutines(db as never, { spaceId: "space", userId: "user" } as never, "bot");
  expect(upsert).not.toHaveBeenCalled();
});

it("synchronizes stale system schedules without resetting usage counters or enabling paused tasks", async () => {
  const upsert = vi.fn();
  const db = {
    routine: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => ({
        id: where.builtinKind,
        builtinKind: where.builtinKind,
        active: where.builtinKind === "daily-review",
        crons: ["0 19 * * *"],
        timezone: "UTC",
      })),
      upsert,
    },
    user: { findUnique: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }) },
  };
  await ensureBuiltinRoutines(db as never, { spaceId: "space", userId: "user" } as never, "bot");
  for (const [args] of upsert.mock.calls) {
    expect(args.update).not.toHaveProperty("active");
    expect(args.update).not.toHaveProperty("usageSince");
    if (args.update.builtinKind === "context-audit")
      expect(args.update).not.toHaveProperty("nextRunAt");
    else {
      expect(args.update.timezone).toBe("Asia/Shanghai");
      expect(args.update.crons).toEqual([
        BUILTIN_ROUTINES.find((d) => d.kind === args.update.builtinKind)!.cron,
      ]);
      if (args.update.builtinKind === "daily-review")
        expect(args.update.nextRunAt).toBeInstanceOf(Date);
      else expect(args.update.nextRunAt).toBeNull();
    }
  }
});
