import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createSpeechSummarizer } from "./speech-summary.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
function fixture(text = "检查完成，有两项需要确认") {
  const requests: AgentRunRequest[] = [];
  const runtime = {
    describe: () => ({ capabilities: { compaction: true } }),
    async *run(request: AgentRunRequest) {
      requests.push(request);
      yield { type: "done", text };
    },
  } as unknown as AgentRuntime;
  const resolveModel = vi.fn(async () => ({ provider: "test", id: "text-model" }));
  const summarize = createSpeechSummarizer(
    {
      prisma: {} as PrismaClient,
      runtime,
      resolveModel,
    },
    { notification: true },
  );
  return { summarize, requests, resolveModel };
}
describe("short voice notifications", () => {
  it("uses a tool-free model to summarize the reply and caches within the user's space", async () => {
    const f = fixture();
    expect(await f.summarize(actor, "bot", "A long task result")).toBe("检查完成，有两项需要确认");
    await f.summarize(actor, "bot", "A long task result");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ tools: [], history: [], prompt: "A long task result" });
    expect(f.requests[0]?.instructions).toContain("20 characters");
    await f.summarize({ ...actor, spaceId: "other" }, "bot", "A long task result");
    expect(f.requests).toHaveLength(2);
  });
  it("rejects an overlong summary instead of reading or truncating the original conclusion", async () => {
    const f = fixture("长".repeat(21));
    expect(await f.summarize(actor, "bot", "Original conclusion")).toBeNull();
  });
  it("never launches a native external agent as an auxiliary summarizer", async () => {
    const f = fixture();
    f.resolveModel.mockResolvedValue({ provider: "openai-compatible", id: "openclaw/default" });
    expect(await f.summarize(actor, "bot", "Task result")).toBeNull();
    expect(f.requests).toHaveLength(0);
  });
});
