import { describe, expect, it, vi } from "vitest";
import { answerRunInput, retireWaitingQuestionInTransaction } from "./events.js";

function fixture(active = true) {
  let status = "waiting_input";
  const card = {
    kind: "ask",
    contextAudit: true,
    ownerOnly: true,
    text: "Audit?",
    status: "pending",
    actions: [
      { id: "start", label: "开始审计" },
      { id: "skip", label: "暂不" },
    ],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    run: {
      findFirst: vi.fn().mockResolvedValue({
        botId: "bot",
        userId: "owner",
        trigger: "routine",
        routine: { id: "routine", builtinKind: "context-audit", active },
        task: { prompt: "Canonical audit instructions" },
      }),
      updateMany: vi.fn().mockImplementation(async ({ data }) => {
        if (data.status) status = data.status;
        return { count: 1 };
      }),
      findUnique: vi
        .fn()
        .mockImplementation(async () => ({ status, firstResponseAt: new Date(), userId: "owner" })),
    },
    routine: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    message: {
      findFirst: vi.fn().mockResolvedValue({ id: "message", blocks: [card] }),
      update: vi.fn(),
    },
    thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 2 }) },
    event: {
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, createdAt: new Date() })),
    },
  };
  const db = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) };
  const input = {
    spaceId: "space",
    threadId: "thread",
    runId: "run",
    messageId: "message",
    answeredByUserId: "owner",
    answer: "start",
  };
  return { tx, db, input, status: () => status };
}

describe("context audit confirmation", () => {
  it("queues the canonical read-only audit only after the owner selects start", async () => {
    const f = fixture();
    expect(await answerRunInput(f.db as never, f.input)).toBe(true);
    expect(f.status()).toBe("queued");
    expect(f.tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "queued", prompt: "Canonical audit instructions" },
      }),
    );
    expect(f.tx.routine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usageSince: expect.any(Date) } }),
    );
  });
  it("ends a declined reminder and preserves the answered card without a model run", async () => {
    const f = fixture();
    expect(await answerRunInput(f.db as never, { ...f.input, answer: "skip" })).toBe(true);
    expect(f.status()).toBe("cancelled");
    expect(f.tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "cancelled", prompt: "Canonical audit instructions" },
      }),
    );
    expect(f.tx.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { blocks: [expect.objectContaining({ status: "answered", answer: "skip" })] },
      }),
    );
  });
  it.each(["different-owner", "free-text"])("rejects %s without queueing work", async (mode) => {
    const f = fixture();
    expect(
      await answerRunInput(f.db as never, {
        ...f.input,
        ...(mode === "different-owner"
          ? { answeredByUserId: "other" }
          : { answer: "Do other work" }),
      }),
    ).toBe(false);
    expect(f.tx.run.updateMany).not.toHaveBeenCalled();
  });
  it("does not start a disabled audit but still allows dismissing its old reminder", async () => {
    const f = fixture(false);
    expect(await answerRunInput(f.db as never, f.input)).toBe(false);
    expect(await answerRunInput(f.db as never, { ...f.input, answer: "skip" })).toBe(true);
  });
});

it("keeps an audit reminder pending when the user sends an unrelated message", async () => {
  const f = fixture();
  const card = {
    kind: "ask",
    contextAudit: true,
    ownerOnly: true,
    text: "Audit?",
    status: "pending",
    actions: [
      { id: "start", label: "开始审计" },
      { id: "skip", label: "暂不" },
    ],
  };
  Object.assign(f.tx.message, {
    findMany: vi.fn().mockResolvedValue([{ id: "message", blocks: [card] }]),
  });
  expect(
    await retireWaitingQuestionInTransaction(f.tx as never, {
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      runId: "run",
      answer: "Do the next job",
    }),
  ).toBe(false);
  expect(f.tx.run.updateMany).not.toHaveBeenCalled();
});
