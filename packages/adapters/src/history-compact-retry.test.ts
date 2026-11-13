import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
} from "@livingbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@livingbot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { compactHistory } from "./history-compaction.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({
  compactHistory: vi.fn(async () => undefined),
  COMPACTION_BATCH_SIZE: 50,
}));

const owner = { spaceId: "space-1", userId: "user-1", nextMessageSeq: 900 };

function fixture(thread: Record<string, unknown> = owner) {
  const enqueue = vi.fn(async (_job: unknown) => undefined);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    thread: { findUnique: vi.fn(async () => thread), updateMany },
  } as unknown as PrismaClient;
  const handlers = createBackgroundJobHandlers({
    executor: { contextStrategy: "current" } as unknown as ReturnType<
      typeof import("./executor.js").createRunExecutor
    >,
    prisma,
    sandbox: {} as unknown as SandboxProvider,
    home: {} as unknown as AgentHomeStore,
    artifacts: {} as unknown as ArtifactStore,
    jobs: { enqueue } as unknown as JobPublisher,
    events: {} as unknown as ThreadEvents,
    workerId: "worker-1",
    runtime: {
      describe: () => ({ capabilities: { sessionContinuity: false, compaction: true } }),
    } as unknown as AgentRuntime,
    secretStore: {} as unknown as EncryptedSecretStore,
    memoryProviders: { resolve: vi.fn(async () => null) } as never,
  });
  return { handlers, enqueue, updateMany };
}

describe("history.compact retry ladder", () => {
  beforeEach(() => {
    vi.mocked(compactHistory).mockReset();
    vi.mocked(compactHistory).mockRejectedValue(new Error("summarizer timed out"));
  });

  it("waits about a minute after the first failure instead of for new messages", async () => {
    const { handlers, enqueue, updateMany } = fixture();
    const before = Date.now();
    await handlers["history.compact"]({ threadId: "thread-1" });

    expect(updateMany).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0]![0] as {
      payload: { threadId: string; attempt?: number };
      availableAt?: Date;
    };
    expect(job.payload).toEqual({ threadId: "thread-1", attempt: 1 });
    expect(job.availableAt!.getTime()).toBeGreaterThanOrEqual(before + 55_000);
    expect(job.availableAt!.getTime()).toBeLessThanOrEqual(Date.now() + 65_000);
  });

  it("stretches the wait as attempts pile up", async () => {
    const { handlers, enqueue } = fixture();
    await handlers["history.compact"]({ threadId: "thread-1", attempt: 1 });
    const job = enqueue.mock.calls[0]![0] as {
      payload: { attempt?: number };
      availableAt?: Date;
    };
    expect(job.payload.attempt).toBe(2);
    expect(job.availableAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it("falls back to waiting for new messages once the ladder is spent", async () => {
    const { handlers, enqueue, updateMany } = fixture();
    await handlers["history.compact"]({ threadId: "thread-1", attempt: 3 });

    expect(enqueue).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { historyCompactionRetryAfterSeq: 950 },
    });
  });

  it("does not reschedule after a successful compaction", async () => {
    vi.mocked(compactHistory).mockResolvedValue(undefined);
    const { handlers, enqueue, updateMany } = fixture();
    await handlers["history.compact"]({ threadId: "thread-1" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
