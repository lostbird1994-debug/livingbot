import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest } from "@livingbot/adapter-kit";
import type { PrismaClient } from "@livingbot/db";
import { describe, expect, it, vi } from "vitest";
import { nativeKernelModel } from "./openclaw-kernel-registry.js";
import { OpenClawKernelProvisioner } from "./openclaw-kernel-provision.js";
import { NATIVE_KERNEL_TOOL_ALLOWLIST } from "./native-collaboration.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rakazo-native-provision-")));
  const configRoot = join(root, "engine");
  const dataDir = join(root, "data");
  const registryRoot = join(dataDir, "openclaw");
  await mkdir(configRoot); await mkdir(registryRoot, { recursive: true });
  const config = { agents: { defaults: {}, list: [{ id: "main", workspace: "/synthetic/existing" }] } };
  await writeFile(join(configRoot, "openclaw.json"), JSON.stringify(config));
  const registryFile = join(registryRoot, "agents.json");
  await writeFile(registryFile, JSON.stringify({ version: 1, migrationCompletedAt: "2026-01-01T00:00:00Z", bots: [] }));
  const bot = { id: "bot-new", userId: "owner", spaceId: "space", name: "Example", description: "Helps",
    instructions: "Own instructions", roleCard: { identity: "Own role" }, computer: null,
    spawnKey: "onboarding:first", createdAt: new Date("2026-11-10T00:00:00Z") };
  const prisma = { bot: { findFirstOrThrow: vi.fn(async ({ where }) => {
    if (where.id !== bot.id || where.spaceId !== bot.spaceId || where.userId !== bot.userId) throw new Error("tenant");
    expect(where).toEqual({ id: bot.id, spaceId: bot.spaceId, userId: bot.userId });
    return bot;
  }) } } as unknown as PrismaClient;
  const waitReady = vi.fn(async () => {});
  const service = new OpenClawKernelProvisioner({
    dataDir, registryFile, prisma, configRoot, waitReady, withLock: async (_key, work) => work(),
  });
  return { root, configRoot, dataDir, registryFile, bot, service, waitReady };
}
const actor = { userId: "owner", spaceId: "space", email: "owner@example.invalid", isDeploymentOwner: false };
describe("native bot and model preparation", () => {
  it("prepares a new isolated native agent without altering the existing main agent", async () => {
    const f = await fixture();
    await f.service.provisionBot(f.bot.id, actor);
    const manifest = JSON.parse(await readFile(f.registryFile, "utf8"));
    const entry = manifest.bots[0];
    expect(entry).toMatchObject({ botId: f.bot.id, spaceId: "space", userId: "owner", chief: true });
    expect(entry.agentId).not.toBe("main");
    expect(entry.sharedWorkspace).toBe(join(f.dataDir, "openclaw/shared/space/owner"));
    expect(await readFile(join(entry.workspace, "AGENTS.md"), "utf8")).toBe("Own instructions");
    const config = JSON.parse(await readFile(join(f.configRoot, "openclaw.json"), "utf8"));
    expect(config.agents.list[0]).toEqual({ id: "main", workspace: "/synthetic/existing" });
    expect(config.agents.list[1]).toMatchObject({ id: entry.agentId, workspace: entry.workspace, contextTokens: 64_000 });
    expect(config.agents.list[1].tools).toEqual({
      allow: NATIVE_KERNEL_TOOL_ALLOWLIST, alsoAllow: [],
    });
    await f.service.provisionBot(f.bot.id, actor);
    expect(JSON.parse(await readFile(f.registryFile, "utf8")).bots).toHaveLength(1);
    expect(f.waitReady).toHaveBeenCalledTimes(1);
  });
  it("never implicitly migrates an old or wrong-owner bot during a read or launch", async () => {
    const f = await fixture();
    f.bot.createdAt = new Date("2025-01-01T00:00:00Z");
    await expect(f.service.provisionBot(f.bot.id, actor)).rejects.toThrow("explicit, backed-up");
    await expect(f.service.provisionBot(f.bot.id, { ...actor, userId: "other" })).rejects.toThrow("tenant");
    expect(JSON.parse(await readFile(f.registryFile, "utf8")).bots).toEqual([]);
    expect(JSON.parse(await readFile(join(f.configRoot, "openclaw.json"), "utf8")).agents.list).toHaveLength(1);
  });
  it("does not overwrite an existing workspace file with new bot settings", async () => {
    const f = await fixture();
    const workspace = join(f.dataDir, "openclaw/workspaces", f.bot.id);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "existing user instructions");
    await expect(f.service.provisionBot(f.bot.id, actor)).rejects.toThrow("explicit adoption");
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("existing user instructions");
  });
  it("registers the exact selected endpoint, credential and wire protocol", async () => {
    const f = await fixture();
    const request = {
      model: { provider: "openai-compatible", id: "test-model", apiKey: "synthetic-key",
        baseUrl: "https://example.invalid/v1", apiProtocol: "responses", acceptsImages: true, contextWindow: 123456 },
    } as AgentRunRequest;
    await f.service.prepareModel(request);
    const config = JSON.parse(await readFile(join(f.configRoot, "openclaw.json"), "utf8"));
    const reference = nativeKernelModel(request, config);
    expect(reference).toMatch(/^rakazo-[a-f0-9]+\/test-model$/);
    const provider = config.models.providers[reference!.split("/")[0]!];
    expect(provider).toMatchObject({
      api: "openai-responses", apiKey: "synthetic-key", baseUrl: request.model.baseUrl,
      models: [{ id: "test-model", input: ["text", "image"], contextWindow: 123456 }],
    });
    expect(f.waitReady).toHaveBeenCalledWith(undefined, reference);
  });
});
