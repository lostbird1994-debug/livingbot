import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  PortableFile,
} from "@rakazo/adapter-kit";
import { BiliWhaleWindowSchema } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { biliWhaleRoutes, readBiliWhaleSettings } from "./bili-whale.js";
import type { RouterContext } from "./context.js";

vi.mock("@rakazo/adapters", () => ({
  acquireComputerExecutionLease: vi.fn(async () => ({ computerId: "computer-1", fence: 1 })),
  releaseComputerExecutionLease: vi.fn(async () => undefined),
  ComputerBusyError: class extends Error {},
  toComputerRef: (computer: { id: string; kind: string; providerRef: string }) => computer,
  resolveBotWorkspacePath: (_scope: string, id: string, file: string) => `bots/${id}/${file}`,
  resolveBotWorkspaceCwd: (_scope: string, id: string, file: string) =>
    file === "." ? `bots/${id}` : `bots/${id}/${file}`,
}));
vi.mock("@rakazo/db", () => ({ parseComputerMode: () => "team" }));

const actor = { userId: "user-1", spaceId: "space-1" };
const getBot = vi.fn();
const writeFile = vi.fn(
  async (_ref: ComputerRef, _file: PortableFile, _context: AdapterContext) => undefined,
);
const execute = vi.fn();
const request = { context: { actor }, input: { botId: "bot-1" } };
function routes() {
  const procedure = { handler: (fn: unknown) => fn };
  const ctx = {
    deps: { prisma: {}, sandbox: { execute, writeFile } },
    repos: { getBot },
    authed: {
      biliWhale: {
        get: procedure,
        save: procedure,
        saveCredentials: procedure,
        deps: procedure,
        planNow: procedure,
      },
    },
  };
  // These handlers are normally invoked by oRPC, after schema/auth middleware.
  return biliWhaleRoutes(ctx as unknown as RouterContext).biliWhale as unknown as Record<
    "get" | "save" | "saveCredentials" | "deps" | "planNow",
    (request: {
      context: { actor: typeof actor };
      input: Record<string, unknown>;
    }) => Promise<unknown>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  getBot.mockResolvedValue({
    id: "bot-1",
    spawnKey: "bili-whale",
    computer: {
      id: "computer-1",
      kind: "desktop",
      scope: "team",
      state: "running",
      providerRef: "host:fixture",
    },
  });
  execute.mockImplementation(async function* (
    _ref: ComputerRef,
    _request: CommandRequest,
    _context: AdapterContext,
  ) {
    yield {
      type: "stdout",
      data: JSON.stringify({
        ready: true,
        config: {},
        plan: null,
        credentials: { configured: false, sessdata: false, biliJct: false, buvid3: false },
      }),
    };
    yield { type: "exit", code: 0 };
  });
});

describe("bili-whale routes", () => {
  it("uses the owned bot's computer and never injects API environment variables", async () => {
    const result = (await routes().get(request)) as { status: { ready: boolean } };
    expect(result.status.ready).toBe(true);
    expect(getBot).toHaveBeenCalledWith(actor, "bot-1");
    expect(execute.mock.lastCall?.[0]).toMatchObject({ providerRef: "host:fixture" });
    expect(execute.mock.lastCall?.[1]).toMatchObject({ cwd: "bots/bot-1", timeoutMs: 120_000 });
    expect(execute.mock.lastCall?.[1]).not.toHaveProperty("env");
  });

  it("rejects access to a bot the actor does not own before any computer operation", async () => {
    getBot.mockRejectedValueOnce(new Error("IsolationError"));
    await expect(routes().get(request)).rejects.toThrow("IsolationError");
    expect(execute).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects ordinary bots even when their workspaces contain a bili script", async () => {
    getBot.mockResolvedValueOnce({ id: "bot-1", spawnKey: null });
    await expect(routes().deps(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires the assigned computer to be running", async () => {
    getBot.mockResolvedValueOnce({
      id: "bot-1",
      spawnKey: "bili-whale",
      computer: { state: "stopped" },
    });
    await expect(routes().get(request)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stages cookies through the computer file interface instead of process arguments", async () => {
    await routes().saveCredentials({
      ...request,
      input: { botId: "bot-1", sessdata: "session-fixture", biliJct: "csrf-fixture", buvid3: "" },
    });
    expect(writeFile.mock.lastCall?.[1].path).toMatch(
      /^bots\/bot-1\/bili-whale\/data\/\.rakazo-settings\/.+\.json$/,
    );
    expect(JSON.stringify(execute.mock.lastCall?.[1])).not.toMatch(/session-fixture|csrf-fixture/);
    expect(execute.mock.lastCall?.[2].runId).toMatch(/^bili-whale:/);
  });

  it("reports failed dependency checks instead of returning success or exposing stderr", async () => {
    execute.mockImplementationOnce(async function* () {
      yield { type: "stderr", data: "fixture-private-diagnostic" };
      yield { type: "exit", code: 1 };
    });
    await expect(routes().deps(request)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("bili-whale validation", () => {
  it.each(["99:99", "24:01", "12:60"])("rejects invalid clock %s", (start) => {
    expect(BiliWhaleWindowSchema.safeParse({ start, end: "24:00", wakes: 1 }).success).toBe(false);
  });
  it("accepts the midnight end boundary", () => {
    expect(
      BiliWhaleWindowSchema.safeParse({ start: "20:00", end: "24:00", wakes: 1 }).success,
    ).toBe(true);
  });
  it("returns a clear configuration error instead of an invalid RPC result", () => {
    expect(() => readBiliWhaleSettings({ night: { maxVideos: 30 } })).toThrow("养鱼配置");
  });
});
