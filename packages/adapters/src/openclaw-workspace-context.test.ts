import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NativeBootstrapEvent } from "./openclaw-workspace-context.js";
import { NativeWorkspaceContext } from "./openclaw-workspace-context.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rakazo-native-context-")));
  const workspace = join(root, "private");
  const sharedWorkspace = join(root, "shared");
  await mkdir(workspace); await mkdir(sharedWorkspace);
  await writeFile(join(workspace, "AGENTS.md"), "current instructions");
  await writeFile(join(workspace, "MEMORY.md"), "current memory");
  await writeFile(join(sharedWorkspace, "MEMORY.md"), "shared memory");
  const registryFile = join(root, "registry.json");
  const entry = { botId: "bot", spaceId: "space", userId: "owner", agentId: "agent-one", workspace, sharedWorkspace };
  await writeFile(registryFile, JSON.stringify({ version: 1, bots: [entry] }));
  const event = (): NativeBootstrapEvent => ({
    context: {
      agentId: "agent-one", workspaceDir: workspace,
      bootstrapFiles: [
        { name: "AGENTS.md", path: join(workspace, "AGENTS.md"), content: "cached old instructions", missing: false },
      ],
    },
  });
  return { root, workspace, sharedWorkspace, registryFile, entry, event };
}
describe("native workspace bootstrap", () => {
  it("assigns file-specific injection limits without shortening stored or bootstrap content", async () => {
    const f = await fixture();
    const memory = "记".repeat(26_000);
    const tools = "工".repeat(21_000);
    await writeFile(join(f.workspace, "MEMORY.md"), memory);
    await writeFile(join(f.workspace, "TOOLS.md"), tools);
    const service = new NativeWorkspaceContext({ registryFile: f.registryFile, config: () => ({}) });
    const event = f.event();
    event.context.bootstrapFiles.push({ name: "TOOLS.md", path: join(f.workspace, "TOOLS.md"), missing: false });
    await service.bootstrap(event);
    expect(event.context.bootstrapFiles.find(file => file.name === "MEMORY.md"))
      .toMatchObject({ maxChars: 25_000, content: memory });
    expect(event.context.bootstrapFiles.find(file => file.name === "TOOLS.md"))
      .toMatchObject({ maxChars: 20_000, content: tools });
    expect(event.context.bootstrapFiles.find(file => file.name === "AGENTS.md"))
      .toMatchObject({ maxChars: 12_000 });
    expect(event.context.bootstrapFiles.find(file => file.name === "工作区共享/MEMORY.md"))
      .toMatchObject({ maxChars: 25_000 });
  });
  it("refreshes private files and shared summaries even with an existing session cache", async () => {
    const f = await fixture();
    const service = new NativeWorkspaceContext({ registryFile: f.registryFile, config: () => ({}) });
    const event = f.event();
    await service.bootstrap(event);
    expect(event.context.bootstrapFiles.find(file => file.name === "AGENTS.md")?.content).toBe("current instructions");
    expect(event.context.bootstrapFiles.find(file => file.path === join(f.workspace, "MEMORY.md"))?.content).toBe("current memory");
    expect(event.context.bootstrapFiles.filter(file => file.path === join(f.sharedWorkspace, "MEMORY.md"))).toHaveLength(1);
    await writeFile(join(f.sharedWorkspace, "MEMORY.md"), "updated shared memory");
    await service.bootstrap(event);
    const shared = event.context.bootstrapFiles.filter(file => file.path === join(f.sharedWorkspace, "MEMORY.md"));
    expect(shared).toHaveLength(1);
    expect(shared[0]?.content).toBe("updated shared memory");
  });
  it("marks externally removed files missing instead of retaining cached facts", async () => {
    const f = await fixture();
    const service = new NativeWorkspaceContext({ registryFile: f.registryFile, config: () => ({}) });
    const event = f.event();
    event.context.bootstrapFiles.push({
      name: "SOUL.md", path: join(f.workspace, "SOUL.md"), content: "no longer on disk", missing: false,
    });
    await service.bootstrap(event);
    expect(event.context.bootstrapFiles.find(file => file.name === "SOUL.md")).toMatchObject({ missing: true, content: undefined });
  });
  it("removes cached private and shared memory from an external-channel bootstrap", async () => {
    const f = await fixture();
    const service = new NativeWorkspaceContext({ registryFile: f.registryFile, config: () => ({}) });
    await writeFile(join(f.workspace, "USER.md"), "private user profile");
    const event = f.event();
    await service.bootstrap(event);
    expect(event.context.bootstrapFiles.some(file => file.name === "MEMORY.md")).toBe(true);
    await service.bootstrap(event, false);
    expect(event.context.bootstrapFiles.map(file => file.name)).toEqual(["AGENTS.md"]);
    expect((await service.guidance("agent-one", false))?.appendSystemContext)
      .not.toContain("Maintain your own MEMORY.md");
  });
  it("updates the engine-owned file array through the installed plugin's shallow context wrapper", async () => {
    const f = await fixture();
    const service = new NativeWorkspaceContext({ registryFile: f.registryFile, config: () => ({}) });
    const engineEvent = f.event();
    await service.bootstrap(engineEvent);
    const originalFiles = engineEvent.context.bootstrapFiles;
    const wrapped = { ...engineEvent, context: { ...engineEvent.context } };
    await service.bootstrap(wrapped, false);
    expect(engineEvent.context.bootstrapFiles).toBe(originalFiles);
    expect(originalFiles.map(file => file.name)).toEqual(["AGENTS.md"]);
  });
  it("rejects wrong workspace and owner without exposing native file contents", async () => {
    const f = await fixture();
    const service = new NativeWorkspaceContext({ registryFile: f.registryFile, config: () => ({}) });
    const event = f.event();
    event.context.workspaceDir = f.sharedWorkspace;
    await expect(service.bootstrap(event)).rejects.toThrow("ownership mismatch");
    await expect(service.preview({ botId: "bot", spaceId: "other", userId: "owner" })).rejects.toThrow("ownership");
  });
  it("uses the engine's returned excerpts and limits, not a second truncation implementation", async () => {
    const f = await fixture();
    const config = { agents: { defaults: { bootstrapMaxChars: 321, bootstrapTotalMaxChars: 1234 } } };
    const bootstrap = vi.fn(async () => ({
      bootstrapFiles: [{ name: "MEMORY.md", path: join(f.workspace, "MEMORY.md"), content: "123456", missing: false }],
      contextFiles: [{ path: join(f.workspace, "MEMORY.md"), content: "1…6" }],
    }));
    const service = new NativeWorkspaceContext({ registryFile: f.registryFile, config: () => config, bootstrap });
    const preview = await service.preview({ botId: "bot", spaceId: "space", userId: "owner" });
    expect(preview.budgets).toEqual({ document: 321, total: 1234 });
    expect(preview.documents[0]).toMatchObject({ excerpt: "1…6", totalChars: 6, shownChars: 3 });
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir: f.workspace, config }));
  });
});
