import { describe, expect, it } from "vitest";
import { RoutineHistorySchema, RoutineSchema } from "@livingbot/contracts";
import type { Message } from "../../../../packages/workbench/src/contracts";
import type { Routine, RoutineReceipt } from "../../../../packages/workbench/src/routines";
import { createLocalRoutinesHandler, productLocalRoutine } from "./local-routines";
import type { LocalRoutinesRequest } from "./local-routines";

const connection = { origin: "http://127.0.0.1:1234", token: "synthetic" };
const original: Routine = {
  id: "routine/one", botId: "bot-1", conversationId: "conversation-1",
  name: "Daily check", message: "Review the task.",
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
  state: "ready", enabled: true, nativeId: "native-1", revision: "r1",
  createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
  nextRunAt: 1_800_000_060_000,
};
const create = {
  botId: "bot-1", name: "Daily check", prompt: "Review the task.",
  crons: ["0 9 * * *"], timezone: "Asia/Shanghai", active: true,
};

function fixture(options: {
  routines?: Routine[]; entries?: RoutineReceipt[]; messages?: Message[];
  failAccess?: boolean; failUpdate?: boolean;
} = {}) {
  let saved = structuredClone(original);
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const request: LocalRoutinesRequest = async <T>(
    received: typeof connection, path: string, init?: RequestInit,
  ): Promise<T> => {
    expect(received).toBe(connection);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    let value: unknown;
    if (path === "/api/routines" && !init) value = { routines: options.routines ?? [saved] };
    else if (path.endsWith("/private-conversation")) value = { id: "conversation-1" };
    else if (path === "/api/routines" && init?.method === "POST") {
      saved = { ...saved, ...body } as Routine;
      value = saved;
    } else if (path.endsWith("/refresh")) value = saved;
    else if (path.endsWith("/update")) {
      if (options.failUpdate) throw new Error("The schedule changed");
      expect(body?.revision).toBe(saved.revision);
      saved = { ...saved, name: String(body?.name), message: String(body?.message),
        schedule: body?.schedule as Routine["schedule"], revision: "r2" };
      value = saved;
    } else if (path.endsWith("/access")) {
      if (options.failAccess) throw new Error("Native access failed");
      expect(body?.revision).toBe(saved.revision);
      saved = { ...saved, enabled: Boolean(body?.enabled), revision: "r3" };
      value = saved;
    } else if (path.endsWith("/history")) value = { entries: options.entries ?? [] };
    else if (path.endsWith("/run")) value = { runId: "native-run-1" };
    else if (path.endsWith("/remove")) saved = { ...saved, state: "removed", enabled: false };
    else if (path === "/api/snapshot") value = {
      conversations: [{ id: "conversation-1", kind: "group" }],
    };
    else if (path.endsWith("/messages")) value = { messages: options.messages ?? [] };
    else throw new Error(`Unexpected endpoint: ${path}`);
    return structuredClone(value) as T;
  };
  return { handle: createLocalRoutinesHandler(connection, request), calls };
}

function receipt(id: string, timestamp: number, patch: Partial<RoutineReceipt> = {}): RoutineReceipt {
  return {
    id, routineId: original.id, botId: original.botId, conversationId: original.conversationId,
    jobId: original.nativeId!, occurrenceKey: id, timestamp, startedAt: timestamp - 100,
    status: "ok", completion: "succeeded", delivery: "not-requested", ...patch,
  };
}

describe("original UI to native routines mapping", () => {
  it("filters by Bot and keeps batch mention groups, including empty groups", async () => {
    const f = fixture({ routines: [original, { ...original, id: "other", botId: "bot-2" }] });
    const list = await f.handle("/routines/list", { botId: "bot-1" }) as unknown[];
    expect(list).toHaveLength(1);
    expect(RoutineSchema.parse(list[0])).toMatchObject({
      prompt: original.message, crons: ["0 9 * * *"], timezone: "Asia/Shanghai",
      nextRunAt: new Date(original.nextRunAt!).toISOString(), active: true,
    });
    expect(await f.handle("routines.listForMentions", { botIds: ["bot-2", "missing"] }))
      .toMatchObject([{ botId: "bot-2", routines: [{ id: "other" }] }, { botId: "missing", routines: [] }]);
  });

  it("gets current native state through refresh and encodes the product id", async () => {
    const f = fixture();
    expect(await f.handle("routines.get", { routineId: original.id })).toMatchObject({ id: original.id });
    expect(f.calls).toEqual([{ path: "/api/routines/routine%2Fone/refresh", method: "POST", body: undefined }]);
  });

  it("creates in the Bot's real private conversation with one native cron", async () => {
    const f = fixture();
    const result = RoutineSchema.parse(await f.handle("routines.create", create));
    expect(result.prompt).toBe(create.prompt);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.path).toBe("/api/bots/bot-1/private-conversation");
    expect(f.calls[1]?.body).toEqual({
      id: expect.any(String), botId: "bot-1", conversationId: "conversation-1",
      name: create.name, message: create.prompt,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
    });
  });

  it.each([
    { active: false }, { crons: ["0 9 * * *", "0 17 * * *"] }, { crons: ["@once"] },
    { webhookEnabled: true }, { githubEnabled: true }, { messageProvider: "slack" },
    { modelProvider: "synthetic", modelId: "synthetic" }, { requireOutput: true },
    { notify: false }, { timezone: "Invalid/Zone" },
  ])("rejects unsupported create options before any calls: %j", async (patch) => {
    const f = fixture();
    await expect(f.handle("routines.create", { ...create, ...patch })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it("uses the refreshed revision and the edit's new revision for a combined enable change", async () => {
    const f = fixture();
    const result = await f.handle("routines.update", {
      routineId: original.id, prompt: "Revised task.", crons: ["0 10 * * *"], active: false,
    });
    expect(result).toMatchObject({ active: false, prompt: "Revised task.", crons: ["0 10 * * *"] });
    expect(f.calls.map((call) => call.path)).toEqual([
      "/api/routines/routine%2Fone/refresh", "/api/routines/routine%2Fone/update",
      "/api/routines/routine%2Fone/access",
    ]);
    expect(f.calls[1]?.body).toMatchObject({ revision: "r1", schedule: { tz: "Asia/Shanghai" } });
    expect(f.calls[2]?.body).toEqual({ revision: "r2", enabled: false });
  });

  it("toggles without editing the schedule, and avoids unchanged writes", async () => {
    const f = fixture();
    await f.handle("routines.update", { routineId: original.id, active: false });
    expect(f.calls.map((c) => c.path.split("/").at(-1))).toEqual(["refresh", "access"]);
    await f.handle("routines.update", { routineId: original.id, active: false });
    expect(f.calls.at(-1)?.path).toContain("/refresh");
  });

  it("does not report success on conflicts or a failed second mutation", async () => {
    const conflict = fixture({ failUpdate: true });
    await expect(conflict.handle("routines.update", {
      routineId: original.id, name: "New name", active: false,
    })).rejects.toThrow("schedule changed");
    expect(conflict.calls.some((call) => call.path.endsWith("/access"))).toBe(false);
    const partial = fixture({ failAccess: true });
    await expect(partial.handle("routines.update", {
      routineId: original.id, name: "New name", active: false,
    })).rejects.toThrow("Native access failed");
  });

  it("preserves exact native at/every schedules and does not invent an interval cron", () => {
    expect(productLocalRoutine({
      ...original, schedule: { kind: "at", at: "2027-01-01T01:02:00.000Z" },
    })).toMatchObject({ crons: ["@once"] });
    expect(productLocalRoutine({
      ...original, schedule: { kind: "every", everyMs: 90_000 },
    })).toMatchObject({ crons: [], editable: false });
    expect(productLocalRoutine({ ...original, state: "pending" }).editable).toBe(false);
  });

  it("updates only a one-shot's explicit time and preserves ordinary metadata", async () => {
    const f = fixture();
    const result = await f.handle("routines.update", {
      routineId: original.id, crons: ["@once"], runAt: "2027-01-01T01:02:00.000Z",
    });
    expect(result).toMatchObject({ name: original.name, crons: ["@once"] });
    expect(f.calls.at(-1)?.body?.schedule).toEqual({ kind: "at", at: "2027-01-01T01:02:00.000Z" });
  });

  it("runs and removes a schedule through the native job it points at", async () => {
    const f = fixture();
    expect(await f.handle("routines.testRun", {
      routineId: original.id, clientNonce: "run-now",
    })).toEqual({ runId: "native-run-1" });
    expect(f.calls.at(-2)?.path).toBe("/api/routines/routine%2Fone/refresh");
    expect(f.calls.at(-1)).toMatchObject({
      path: "/api/routines/routine%2Fone/run", method: "POST",
      body: { revision: "r1", clientNonce: "run-now" },
    });
    expect(await f.handle("routines.remove", { routineId: original.id })).toEqual({ ok: true });
    expect(f.calls.at(-1)).toMatchObject({
      path: "/api/routines/routine%2Fone/remove", method: "POST", body: { revision: "r1" },
    });
  });

  it("refuses an unknown procedure and unsupported options without touching native routines", async () => {
    const f = fixture();
    await expect(f.handle("routines.unknown", { routineId: original.id })).rejects.toThrow();
    await expect(f.handle("routines.update", {
      routineId: original.id, githubEnabled: true,
    })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe("native receipt to original history mapping", () => {
  it("pages tied timestamps without losing receipts or repeating the cursor", async () => {
    const stamp = original.createdAt;
    const entries = [receipt("a", stamp), receipt("c", stamp), receipt("b", stamp), receipt("older", stamp - 1)];
    const f = fixture({ entries });
    const first = RoutineHistorySchema.parse(await f.handle("routines.history", {
      routineId: original.id, limit: 2,
    }));
    expect(first.runs.map((r) => r.id)).toEqual(["c", "b"]);
    const second = RoutineHistorySchema.parse(await f.handle("routines.history", {
      routineId: original.id, limit: 2, before: first.nextCursor,
    }));
    expect(second.runs.map((r) => r.id)).toEqual(["a", "older"]);
    expect(second.nextCursor).toBeNull();
    expect(f.calls[0]?.path.endsWith("/refresh")).toBe(true);
  });

  it("only confirms native success and only links an exact final assistant reply", async () => {
    const stamp = original.createdAt;
    const entries = [
      receipt("success", stamp, { runId: "run-1" }),
      receipt("uncertain", stamp, { status: "unknown", completion: "unknown" }),
      receipt("failed", stamp, { status: "error", completion: "failed", error: "Native failure" }),
      receipt("skipped", stamp, { status: "skipped", completion: undefined }),
      receipt("unconfirmed", stamp, { completion: undefined, runId: "run-unconfirmed" }),
    ];
    const final: Message = {
      id: "message-1", conversationId: original.conversationId, botId: original.botId,
      runId: "run-1", role: "assistant", blocks: [{ id: "text-1", kind: "text", text: "Done." }],
      createdAt: stamp, updatedAt: stamp, final: true,
    };
    const f = fixture({ entries, messages: [
      { ...final, id: "wrong-bot", botId: "bot-2" },
      { ...final, id: "wrong-conversation", conversationId: "other" },
      { ...final, id: "partial", final: false }, final,
    ] });
    const page = RoutineHistorySchema.parse(await f.handle("routines.history", { routineId: original.id }));
    const byId = Object.fromEntries(page.runs.map((r) => [r.id, r]));
    expect(byId.success).toMatchObject({ status: "completed", messageId: "message-1", groupId: "conversation-1" });
    expect(byId.uncertain).toMatchObject({ status: "failed", completedAt: null, messageId: null });
    expect(byId.failed).toMatchObject({ status: "failed", error: "Native failure" });
    expect(byId.skipped).toMatchObject({ status: "cancelled" });
    expect(byId.unconfirmed).toMatchObject({ status: "failed", messageId: null });
  });

  it("rejects history with mismatched native ownership", async () => {
    const f = fixture({ entries: [receipt("foreign", original.createdAt, { botId: "bot-2" })] });
    await expect(f.handle("routines.history", { routineId: original.id })).rejects.toThrow("ownership");
  });
});
