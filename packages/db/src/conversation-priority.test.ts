import { describe, expect, it, vi } from "vitest";
import { prioritizeConversation } from "./conversation-priority.js";
import { createPendingSteeringRun } from "./events.js";

const run = { id: "check", spaceId: "space", threadId: "thread", botId: "bot" };

function fixture(active: { id: string; status: string; trigger: string } | null, pending = true) {
  let continuation: { id: string; status: string; trigger: string } | null = null;
  const tx = {
    $queryRaw: vi.fn(),
    run: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.NOT) {
          const candidate = continuation ?? active;
          return candidate &&
            !(candidate.status === "queued" && ["routine", "reaction"].includes(candidate.trigger))
            ? candidate
            : null;
        }
        return (
          continuation ??
          (active && !["routine", "reaction"].includes(active.trigger) ? active : null)
        );
      }),
      create: vi.fn(
        async () => (continuation = { id: "reply", status: "queued", trigger: "follow_up" }),
      ),
    },
    steeringMessage: {
      findMany: vi.fn(async () =>
        pending
          ? [
              {
                id: "message",
                userId: "user",
                originTrigger: null,
                message: { id: "source", blocks: [{ kind: "text", text: "Correction" }], seq: 2 },
              },
            ]
          : [],
      ),
      updateMany: vi.fn(),
    },
    task: { create: vi.fn(async () => ({ id: "task" })) },
  };
  return { tx, db: { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } };
}

describe("conversation priority", () => {
  it.each(["routine", "reaction"])(
    "materializes pending user messages ahead of queued %s",
    async (trigger) => {
      const { tx, db } = fixture({ id: "check", status: "queued", trigger });
      expect(await prioritizeConversation(db as never, run)).toEqual({
        blocked: true,
        continuationRunId: "reply",
      });
      expect(await prioritizeConversation(db as never, run)).toEqual({
        blocked: true,
        continuationRunId: null,
      });
      expect(tx.run.create).toHaveBeenCalledTimes(1);
      expect(tx.steeringMessage.updateMany).toHaveBeenCalledTimes(1);
    },
  );
  it("does not interrupt a running check or consume its pending messages", async () => {
    const { tx } = fixture({ id: "check", status: "running", trigger: "routine" });
    expect(await createPendingSteeringRun(tx as never, run)).toBeNull();
    expect(tx.steeringMessage.updateMany).not.toHaveBeenCalled();
  });
  it("keeps existing queued replies ahead of checks", async () => {
    const { db } = fixture({ id: "reply", status: "queued", trigger: "follow_up" });
    expect(await prioritizeConversation(db as never, run)).toEqual({
      blocked: true,
      continuationRunId: null,
    });
  });
  it("allows checks when no user message is waiting", async () => {
    const { db } = fixture({ id: "check", status: "queued", trigger: "routine" }, false);
    expect(await prioritizeConversation(db as never, run)).toEqual({
      blocked: false,
      continuationRunId: null,
    });
  });
});
