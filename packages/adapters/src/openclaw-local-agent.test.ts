import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@livingbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as LocalAgentRuntime from "./local-agent-runtime.js";
import { runLocalAgent } from "./local-agent-runtime.js";
import { OpenClawAgentRuntime } from "./openclaw-kernel.js";
import type { NativeStore } from "./openclaw-native-driver.js";

vi.mock("./local-agent-runtime.js", async (original) => ({
  ...(await original<typeof LocalAgentRuntime>()),
  runLocalAgent: vi.fn(),
}));

const actor: Partial<AdapterContext> = { spaceId: "space", userId: "user" };
const request: AgentRunRequest = {
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "Hello",
  instructions: "Role",
  history: [],
  tools: [],
  model: { provider: "openai-compatible", id: "native/workbuddy/selected" },
};
function fixture() {
  const resolveAgent = vi
    .fn()
    .mockRejectedValue(new Error("Must not provision a desktop agent as a model"));
  const store: NativeStore = { read: vi.fn(), write: vi.fn() };
  return { runtime: new OpenClawAgentRuntime({ store, resolveAgent }), resolveAgent, store };
}

describe("desktop agents with the OpenClaw engine", () => {
  it.each(["codex", "workbuddy"])(
    "dispatches %s to its native bridge before model provisioning",
    async (engine) => {
      const f = fixture();
      const expected: AgentRuntimeEvent[] = [
        { type: "progress", text: "Working" },
        { type: "text", text: "Result" },
        { type: "done", text: "Result" },
      ];
      vi.mocked(runLocalAgent).mockImplementation(async function* (input, context) {
        expect(input).toBe(selected);
        expect(context).toMatchObject(actor);
        expect(context.signal?.aborted).toBe(false);
        yield* expected;
      });
      const selected = { ...request, model: { ...request.model, id: `native/${engine}/selected` } };
      const events: AgentRuntimeEvent[] = [];
      for await (const event of f.runtime.run(selected, actor)) events.push(event);
      expect(events).toEqual(expected);
      expect(f.resolveAgent).not.toHaveBeenCalled();
      expect(f.store.write).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "workbuddy"])("keeps %s inside the run's stop boundary", async (engine) => {
    const f = fixture();
    let stopped = false;
    vi.mocked(runLocalAgent).mockImplementation(async function* (_input, context) {
      const aborted = new Promise<void>((resolve) => {
        context.signal!.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve();
          },
          { once: true },
        );
      });
      yield { type: "progress", text: "Working" };
      await aborted;
    });
    const stream = f.runtime.run(
      { ...request, model: { ...request.model, id: `native/${engine}` } },
      actor,
    );
    expect((await stream.next()).done).toBe(false);
    await f.runtime.abort(request.runId);
    expect(stopped).toBe(true);
    expect((await stream.next()).done).toBe(true);
  });

  it("requires tenant context before dispatching a desktop task", async () => {
    const f = fixture();
    vi.mocked(runLocalAgent).mockClear();
    await expect(f.runtime.run(request).next()).rejects.toThrow("requires tenant context");
    expect(runLocalAgent).not.toHaveBeenCalled();
  });
});
