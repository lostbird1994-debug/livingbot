import type { TaskWork, TaskWorkDefinition, TaskWorkScope } from "@livingbot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  rows: new Map<string, TaskWork>(),
  effects: new Map<string, string>(),
}));

vi.mock("@livingbot/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@livingbot/db")>();
  const active = new Set(["starting", "running", "polling", "stopping", "unconfirmed"]);
  return {
    ...actual,
    TASK_WORK_ACTIVE: [...active].map((state) => `work_${state}`),
    TASK_WORK_KIND: "task_work_v1",
    listTaskWork: vi.fn(
      async (_prisma, _scope, options: { activeOnly?: boolean; id?: string } = {}) =>
        [...storage.rows.values()].filter(
          (work) =>
            (!options.id || work.id === options.id) &&
            (!options.activeOnly || active.has(work.state)),
        ),
    ),
    registerTaskWork: vi.fn(
      async (
        _prisma,
        _scope: TaskWorkScope,
        runId: string,
        effectKey: string,
        definition: TaskWorkDefinition,
      ) => {
        const priorId = storage.effects.get(effectKey);
        if (priorId) return { work: storage.rows.get(priorId)!, created: false };
        const work: TaskWork = {
          id: "work-1",
          runId,
          state: "starting",
          updatedAt: new Date(),
          definition: { ...definition },
          receipt: {},
        };
        storage.effects.set(effectKey, work.id);
        storage.rows.set(work.id, work);
        return { work, created: true };
      },
    ),
    writeTaskWork: vi.fn(
      async (
        _prisma,
        _scope,
        work: TaskWork,
        state: TaskWork["state"],
        receipt: TaskWork["receipt"],
      ) => {
        const current = storage.rows.get(work.id);
        if (!current || current.state !== work.state || current.updatedAt !== work.updatedAt)
          return null;
        const saved = {
          ...current,
          state,
          receipt,
          updatedAt: new Date(current.updatedAt.getTime() + 1),
        };
        storage.rows.set(work.id, saved);
        return saved;
      },
    ),
    requestTaskWorkStop: vi.fn(async (_prisma, _scope: TaskWorkScope, work: TaskWork) => {
      const current = storage.rows.get(work.id);
      if (!current || current.state !== work.state || current.updatedAt !== work.updatedAt)
        return null;
      const saved = {
        ...current,
        state: "stopping" as const,
        receipt: { ...current.receipt, stopRequested: true },
        updatedAt: new Date(current.updatedAt.getTime() + 1),
      };
      storage.rows.set(work.id, saved);
      return saved;
    }),
    runAsSystem: vi.fn(async (_label: string, action: () => Promise<unknown>) => action()),
    runAsTenant: vi.fn(async (_owner: unknown, action: () => Promise<unknown>) => action()),
  };
});

import { createTaskWorkService } from "./task-work.js";

const scope: TaskWorkScope = { spaceId: "space", userId: "user", botId: "bot", threadId: "thread" };
const definition: TaskWorkDefinition = {
  name: "export",
  computerId: "computer",
  start: "start",
  poll: "poll",
  cancel: "cancel",
};

beforeEach(() => {
  storage.rows.clear();
  storage.effects.clear();
});

describe("managed task work", () => {
  it("does not relaunch a start whose outcome was uncertain", async () => {
    const command = vi.fn(async () => {
      throw new Error("connection lost after launch");
    });
    const service = createTaskWorkService({ prisma: {} as never } as never, command);

    const first = await service.start(scope, "run", "effect-1", definition);
    const retry = await service.start(scope, "run", "effect-1", definition);

    expect(first.state).toBe("unconfirmed");
    expect(retry.state).toBe("unconfirmed");
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ state: "starting" }),
      "start",
    );
  });

  it("keeps a stop pending until the driver confirms a terminal state", async () => {
    storage.rows.set("work-1", {
      id: "work-1",
      runId: "run",
      state: "running",
      updatedAt: new Date(0),
      definition,
      receipt: { handle: "host-job-1" },
    });
    const command = vi.fn(async (_scope, work: TaskWork, action: string) => {
      expect(action).toBe("cancel");
      expect(work.receipt.stopRequested).toBe(true);
      return { stdout: JSON.stringify({ status: "running" }), stderr: "", code: 0 };
    });
    const service = createTaskWorkService({ prisma: {} as never } as never, command);

    const stopped = await service.stop(scope, "work-1");

    expect(stopped.state).toBe("stopping");
    expect(stopped.receipt.stopRequested).toBe(true);
    expect(command).toHaveBeenCalledTimes(1);
  });
});
