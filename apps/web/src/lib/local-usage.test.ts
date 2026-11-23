// The payload below is a trimmed copy of a real response recorded on 2026-11-21 by
// local/validation/usage-probe-20261121.ts: one synthetic turn on the official kernel,
// read back through /api/usage. Field names and numbers are the kernel's own.
import { expect, it } from "vitest";
import { conversationUsage } from "./local-workbench";

const REAL = {
  sessions: [
    {
      key: "agent:usage:explicit:livingbot-0000",
      agentId: "usage",
      usage: {
        input: 234,
        output: 56,
        cacheRead: 1000,
        cacheWrite: 0,
        totalTokens: 1290,
        latency: { count: 1, avgMs: 2002, p95Ms: 2002 },
        messageCounts: { total: 2, user: 1, assistant: 1 },
        modelUsage: [
          { provider: "synthetic", model: "synthetic", count: 1, totals: { totalTokens: 1290 } },
        ],
      },
    },
  ],
  timeseries: {
    sessionId: "session-1",
    points: [
      {
        timestamp: 1_795_198_956_614,
        input: 234,
        output: 56,
        cacheRead: 1000,
        cacheWrite: 0,
        totalTokens: 1290,
        cost: 0,
      },
    ],
  },
  latestRun: {
    id: "run-1",
    status: "completed",
    startedAt: 1_795_198_954_732,
    completedAt: 1_795_198_956_767,
  },
};

it("reads the official session totals, including the cache the kernel reports separately", () => {
  const usage = conversationUsage("thread-1", REAL);
  expect(usage.total).toMatchObject({
    calls: 1,
    reportedCalls: 1,
    // The kernel reports uncached input; the prompt is input + cacheRead.
    inputTokens: 1234,
    outputTokens: 56,
    cacheReadTokens: 1000,
    tokens: 1290,
    knownTokens: 1290,
    // Native latency can include tools/waits; never label it model time.
    modelDurationMs: null,
  });
  // 1000 cached of a 1234-token prompt, not of input+output.
  expect(usage.total.cacheHitRate).toBeCloseTo(1000 / 1234, 6);
  expect(usage.total.tokensPerSecond).toBeNull();
});

it("reports the latest run's own usage instead of leaving the composer blank", () => {
  const usage = conversationUsage("thread-1", REAL);
  expect(usage.latest).toMatchObject({
    runId: "run-1",
    status: "completed",
    inputTokens: 1234,
    outputTokens: 56,
    cacheReadTokens: 1000,
    tokens: 1290,
  });
  expect(usage.latest?.startedAt).toBe(new Date(1_795_198_954_732).toISOString());
  expect(usage.latest?.completedAt).toBe(new Date(1_795_198_956_767).toISOString());
  // Task wall time includes tool/approval waits and is not generation time.
  expect(usage.latest?.tokensPerSecond).toBeNull();
});

it("adds every native call in the latest task and excludes stale timeseries", () => {
  const usage = conversationUsage("thread-1", {
    ...REAL,
    latestCalls: [
      { input: 234, output: 56, cacheRead: 1000, cacheWrite: 0, totalTokens: 1290 },
      { input: 300, output: 80, cacheRead: 1000, cacheWrite: 0, totalTokens: 1380 },
    ],
  });
  expect(usage.latest).toMatchObject({
    calls: 2,
    tokens: 2670,
    inputTokens: 2534,
    outputTokens: 136,
    cacheReadTokens: 2000,
    tokensPerSecond: null,
  });
  expect(conversationUsage("thread-1", { ...REAL, latestCalls: [] }).latest).toBeNull();
  expect(
    conversationUsage("thread-1", {
      ...REAL,
      latestRun: { ...REAL.latestRun, startedAt: REAL.latestRun.completedAt + 1 },
    }).latest,
  ).toBeNull();
});

it("keeps unreported numbers unknown and refuses an unrecognized payload", () => {
  const partial = conversationUsage("thread-1", {
    sessions: [
      {
        usage: {
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
          totalTokens: null,
          latency: { count: 2 },
        },
      },
    ],
    timeseries: null,
    latestRun: null,
  });
  expect(partial.total.tokens).toBeNull();
  expect(partial.total.inputTokens).toBeNull();
  expect(partial.total.cacheHitRate).toBeNull();
  expect(partial.total.calls).toBe(2);
  expect(partial.latest).toBeNull();
  // A response without `sessions` is not "no usage": it is a contract violation.
  expect(() => conversationUsage("thread-1", {} as never)).toThrow(/未知结构/);
});

it("uses only measured generation duration for speed across every call of the latest run", () => {
  const first = { input: 234, output: 56, cacheRead: 1000, cacheWrite: 0, totalTokens: 1290 };
  const second = { input: 300, output: 80, cacheRead: 1000, cacheWrite: 0, totalTokens: 1380 };
  const measured = conversationUsage("thread-1", {
    ...REAL,
    latestCalls: [
      { ...first, generationDurationMs: 2000 },
      { ...second, generationDurationMs: 1000 },
    ],
  });
  expect(measured.latest?.tokensPerSecond).toBeCloseTo(136 / 3);
  // Omitting one call's measurement must not turn its tokens into free throughput.
  const partial = conversationUsage("thread-1", {
    ...REAL,
    latestCalls: [{ ...first, generationDurationMs: 2000 }, second],
  });
  expect(partial.latest?.tokensPerSecond).toBeNull();
  const absent = conversationUsage("thread-1", {
    ...REAL,
    latestCalls: [{ ...first, generationDurationMs: 0 }],
  });
  expect(absent.latest?.tokensPerSecond).toBeNull();
  const zero = conversationUsage("thread-1", {
    ...REAL,
    latestCalls: [{ ...first, generationDurationMs: 2000 }, { ...second, generationDurationMs: 0 }],
  });
  expect(zero.latest?.tokensPerSecond).toBeNull();
  expect(zero.latest?.modelDurationMs).toBeNull();
});

it("does not convert native request or user-to-assistant latency into generation timing", () => {
  const usage = conversationUsage("thread-1", {
    ...REAL,
    latestCalls: [{
      input: 234, output: 56, cacheRead: 1000, cacheWrite: 0, totalTokens: 1290,
      latency: { count: 1, avgMs: 2002 },
    }],
  });
  expect(usage.total.modelDurationMs).toBeNull();
  expect(usage.latest?.modelDurationMs).toBeNull();
  expect(usage.latest?.tokensPerSecond).toBeNull();
});

it("exposes the native model request duration separately without fabricating generation speed", () => {
  const usage = conversationUsage("thread-1", { ...REAL, latestModelRequestDurationMs: 1734 });
  expect(usage.latest?.modelRequestDurationMs).toBe(1734);
  expect(usage.latest?.modelDurationMs).toBeNull();
  expect(usage.latest?.tokensPerSecond).toBeNull();
  expect(conversationUsage("thread-1", REAL).latest?.modelRequestDurationMs).toBeNull();
  expect(conversationUsage("thread-1", { ...REAL, latestModelRequestDurationMs: 0 })
    .latest?.modelRequestDurationMs).toBe(0);
});

it("keeps the selected previous reading, updates on completion, and isolates conversations", () => {
  const previous = conversationUsage("thread-1", REAL);
  const running = conversationUsage("thread-1", { ...REAL, latestCalls: REAL.timeseries.points });
  expect(running.latest).toEqual(previous.latest);
  const firstTurn = conversationUsage("thread-2", {
    sessions: [], latestRun: { id: "run-2", status: "running", startedAt: 3000, completedAt: null },
    latestCalls: [],
  });
  expect(firstTurn.latest).toBeNull();
  expect(firstTurn.total.tokens).toBeNull();
  const completed = conversationUsage("thread-1", {
    ...REAL,
    latestRun: { id: "run-2", status: "completed", startedAt: 3000, completedAt: 6000 },
    latestCalls: [{ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 }],
  });
  expect(completed.latest).toMatchObject({ runId: "run-2", tokens: 30, tokensPerSecond: null });
  expect(conversationUsage("thread-2", { sessions: [], latestCalls: [], latestRun: null }).latest).toBeNull();
});
