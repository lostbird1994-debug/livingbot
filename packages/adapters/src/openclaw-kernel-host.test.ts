import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { MemoryStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createOpenClawKernelHost } from "./openclaw-kernel-host.js";

it("checks orphaned sessions within the verified owner's scope without treating actor metadata as database fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "rakazo-native-stop-host-"));
  await mkdir(join(root, "openclaw"));
  await writeFile(join(root, "openclaw/agents.json"), JSON.stringify({ version: 1, bots: [{
    botId: "bot", spaceId: "space", userId: "owner", agentId: "test-agent",
    workspace: join(root, "private"), sharedWorkspace: join(root, "shared"),
  }] }));
  const findMany = vi.fn(async () => [{ id: "routine" }]);
  const host = createOpenClawKernelHost({ dataDir: root, encryptionKey: "synthetic-key",
    prisma: { routine: { findMany } } as unknown as PrismaClient,
    mirror: {} as MemoryStore, notify: async () => {},
  });
  const actor = { spaceId: "space", userId: "owner", email: "synthetic@example.invalid", isDeploymentOwner: false };
  await host.stopNativeOrphans(actor, "bot", "thread", Date.now());
  expect(findMany).toHaveBeenCalledExactlyOnceWith({ where: { botId: "bot", spaceId: "space", userId: "owner" }, select: { id: true } });
  await expect(host.stopNativeOrphans({ ...actor, userId: "someone-else" }, "bot", "thread", Date.now()))
    .rejects.toThrow();
  expect(findMany).toHaveBeenCalledTimes(1);
});
