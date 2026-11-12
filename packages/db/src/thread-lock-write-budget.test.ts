import { expect, it, vi } from "vitest";
import { createThreadMessage } from "./messages.js";

it("keeps a message write alive behind a snapshot lock without shortening connection checkout", async () => {
  const create = vi.fn(async ({ data }: { data: unknown }) => ({
    id: "message",
    ...(data as object),
  }));
  const tx = {
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 2 })) },
    message: { create },
  };
  const prisma = {
    $transaction: vi.fn(
      async (
        work: (client: unknown) => Promise<unknown>,
        options?: { timeout?: number; maxWait?: number },
      ) => {
        // A snapshot can legitimately hold this lock longer than Prisma's default 5s.
        const snapshotLockMs = 6_000;
        if ((options?.timeout ?? 5_000) <= snapshotLockMs)
          throw Object.assign(new Error("Transaction expired while waiting for thread lock"), {
            code: "P2028",
          });
        expect(options).not.toHaveProperty("maxWait");
        return work(tx);
      },
    ),
  };
  await expect(
    createThreadMessage(prisma as never, {
      threadId: "thread",
      role: "user",
      blocks: [{ kind: "text", text: "A reply" }],
    }),
  ).resolves.toMatchObject({ id: "message", seq: 1 });
  expect(create).toHaveBeenCalledTimes(1);
});
