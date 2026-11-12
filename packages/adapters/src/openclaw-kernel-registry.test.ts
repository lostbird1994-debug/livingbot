import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { nativeKernelModel, resolveKernelAgent } from "./openclaw-kernel-registry.js";
import type { KernelEngineConfig } from "./openclaw-kernel-registry.js";
const request: AgentRunRequest = {
  botId: "bot", runId: "run", threadId: "thread", prompt: "Task", instructions: "", history: [], tools: [],
  model: { provider: "openai-compatible", id: "flash", baseUrl: "https://example.invalid/v1", apiKey: "fake" },
};
const config: KernelEngineConfig = {
  gateway: { port: 18789, auth: { token: "synthetic-token" } },
  agents: { list: [{ id: "bot-one", workspace: "/synthetic/one" }] },
  models: { providers: { test: {
    baseUrl: "https://example.invalid/v1/", apiKey: "fake", models: [{ id: "flash" }],
  } } },
};
const entry = { botId: "bot", spaceId: "space", userId: "user", agentId: "bot-one",
  workspace: "/synthetic/one", sharedWorkspace: "/synthetic/shared" };
describe("native kernel registry", () => {
  it("matches the actual selected connection instead of choosing by model name", () => {
    expect(nativeKernelModel(request, config)).toBe("test/flash");
    expect(() => nativeKernelModel({ ...request, model: { ...request.model, apiKey: "other" } }, config)).toThrow("not been registered");
    expect(() => nativeKernelModel({ ...request, model: { ...request.model, baseUrl: "https://other.invalid/v1" } }, config)).toThrow("not been registered");
  });
  it("requires matching tenant, bot and engine workspace", () => {
    expect(resolveKernelAgent(entry, request, { spaceId: "space", userId: "user" }, config))
      .toMatchObject({ agentId: "bot-one", modelId: "test/flash" });
    expect(() => resolveKernelAgent(entry, request, { spaceId: "other", userId: "user" }, config)).toThrow("tenant");
    expect(() => resolveKernelAgent({ ...entry, workspace: "/synthetic/other" }, request,
      { spaceId: "space", userId: "user" }, config)).toThrow("workspace");
    expect(() => resolveKernelAgent({ ...entry, agentId: "main" }, request,
      { spaceId: "space", userId: "user" }, config)).toThrow("workspace");
  });
  it("does not reuse a connection with a different wire protocol", () => {
    const responses = { ...request, model: { ...request.model, apiProtocol: "responses" as const } };
    expect(() => nativeKernelModel(responses, config)).toThrow("not been registered");
    expect(nativeKernelModel(responses, {
      ...config, models: { providers: { test: { ...config.models!.providers!.test!, api: "openai-responses" } } },
    })).toBe("test/flash");
  });
});
