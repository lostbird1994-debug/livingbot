import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@livingbot/db";
import { botRoleCard } from "@livingbot/contracts";
import type { OpenClawKernelRegistry } from "./openclaw-kernel-registry.js";
import { OpenClawWorkspaceProfiles } from "./openclaw-workspace-profile.js";

const { commit } = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock("@livingbot/db", () => ({ commitBotUpdate: commit }));
beforeEach(() => { commit.mockReset(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rakazo-native-profile-")));
  const actor = { userId: "owner", spaceId: "space", email: "owner@example.invalid", isDeploymentOwner: false };
  const state = { id: "bot", instructions: "old instructions",
    roleCard: botRoleCard({ identity: "Test identity" }), thread: { id: "thread" } };
  await Promise.all(Object.entries({
    "AGENTS.md": state.instructions, "IDENTITY.md": state.roleCard.identity,
    "SOUL.md": "", "USER.md": "",
  }).map(([name, value]) => writeFile(join(root, name), value)));
  const prisma = { bot: { findFirstOrThrow: vi.fn(async ({ where }) => {
    expect(where).toEqual({ id: state.id, userId: actor.userId, spaceId: actor.spaceId });
    return structuredClone(state);
  }) } } as unknown as PrismaClient;
  commit.mockImplementation(async (options: any) => { Object.assign(state, options.data); return { id: "bot" }; });
  const registry = {
    entry: vi.fn(async (botId, scope) => {
      if (botId !== state.id || scope.spaceId !== actor.spaceId || scope.userId !== actor.userId)
        throw new Error("tenant mismatch");
      return { workspace: root };
    }),
  } as unknown as OpenClawKernelRegistry;
  const service = new OpenClawWorkspaceProfiles({
    prisma, registry, notify: async () => {}, withLock: async (_key, work) => work(),
  });
  return { root, actor, state, service };
}
describe("native bot profile", () => {
  it("mirrors a native instruction edit through the existing revision-preserving commit", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "AGENTS.md"), "engine instructions");
    await f.service.refresh(f.actor, "bot");
    expect(f.state.instructions).toBe("engine instructions");
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      expectedInstructions: "old instructions", reason: "Native workspace update",
    }));
  });
  it("writes UI profile edits to the same real files, including previously empty modules", async () => {
    const f = await fixture();
    await f.service.edit(f.actor, "bot", async () => {
      f.state.instructions = "new instructions";
      f.state.roleCard.personality = "patient";
    });
    expect(await readFile(join(f.root, "AGENTS.md"), "utf8")).toBe("new instructions");
    expect(await readFile(join(f.root, "SOUL.md"), "utf8")).toBe("patient");
  });
  it("refreshes native changes before checking a stale UI edit", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "AGENTS.md"), "engine update");
    await expect(f.service.edit(f.actor, "bot", async () => {
      if (f.state.instructions !== "old instructions") throw new Error("conflict");
      f.state.instructions = "stale UI";
    })).rejects.toThrow("conflict");
    expect(await readFile(join(f.root, "AGENTS.md"), "utf8")).toBe("engine update");
  });
  it("never overwrites an engine change arriving during the host save", async () => {
    const f = await fixture();
    await expect(f.service.edit(f.actor, "bot", async () => {
      await writeFile(join(f.root, "AGENTS.md"), "arrived meanwhile");
      f.state.instructions = "UI proposal";
    })).rejects.toThrow("changed since");
    expect(await readFile(join(f.root, "AGENTS.md"), "utf8")).toBe("arrived meanwhile");
    expect(f.state.instructions).toBe("arrived meanwhile");
  });
  it("checks all changed modules before saving the first one", async () => {
    const f = await fixture();
    await expect(f.service.edit(f.actor, "bot", async () => {
      f.state.roleCard.identity = "UI identity";
      f.state.instructions = "UI instructions";
      await writeFile(join(f.root, "AGENTS.md"), "concurrent native instructions");
    })).rejects.toThrow("changed since");
    expect(await readFile(join(f.root, "IDENTITY.md"), "utf8")).toBe("Test identity");
    expect(f.state.roleCard.identity).toBe("Test identity");
    expect(f.state.instructions).toBe("concurrent native instructions");
  });
});

it("edits context sources without renaming files and rejects stale or unsafe writes", async () => {
  const f = await fixture();
  await f.service.updateDocument(f.actor, { botId: "bot", scope: "bot", name: "AGENTS.md", content: "New full source", expectedContent: "old instructions" });
  expect(await readFile(join(f.root, "AGENTS.md"), "utf8")).toBe("New full source");
  await expect(f.service.updateDocument(f.actor, { botId: "bot", scope: "bot", name: "AGENTS.md", content: "Stale", expectedContent: "old instructions" })).rejects.toThrow();
  expect(await readFile(join(f.root, "AGENTS.md"), "utf8")).toBe("New full source");
  await expect(f.service.updateDocument(f.actor, { botId: "bot", scope: "bot", name: "../AGENTS.md", content: "Escaped", expectedContent: "" })).rejects.toThrow("Unsupported");
  await expect(f.service.updateDocument(f.actor, { botId: "bot", scope: "user", name: "AGENTS.md", content: "Wrong scope", expectedContent: "" })).rejects.toThrow("Unsupported");
});

it("recovers only a verified owner's explicit Bot suffix and refuses traversal", async () => {
 const f = await fixture();
 await expect(f.service.resolveDocument(f.actor, "/bots/bot/AGENTS.md")).resolves.toBe(join(f.root,"AGENTS.md"));
 await expect(f.service.resolveDocument(f.actor, "/bots/other/AGENTS.md")).resolves.toBeUndefined();
 await expect(f.service.resolveDocument(f.actor, "/bots/bot/../secret.md")).resolves.toBeUndefined();
 await expect(f.service.resolveDocument(f.actor, "/Users/test/report.md")).resolves.toBeUndefined();
});

it("resolves recorded attachment sources only inside the owner's registered workspace", async () => {
 const f = await fixture();
 await expect(f.service.resolveSourceDocument(f.actor, "bot", "AGENTS.md")).resolves.toBe(join(f.root,"AGENTS.md"));
 await expect(f.service.resolveSourceDocument(f.actor, "bot", join(f.root,"AGENTS.md"))).resolves.toBe(join(f.root,"AGENTS.md"));
 await expect(f.service.resolveSourceDocument(f.actor, "other", "AGENTS.md")).resolves.toBeUndefined();
 await expect(f.service.resolveSourceDocument(f.actor, "bot", "../secret.md")).resolves.toBeUndefined();
 await expect(f.service.resolveSourceDocument(f.actor, "bot", "/Users/test/report.md")).resolves.toBeUndefined();
});
