import { describe, expect, it } from "vitest";
import { localAgentModelId, parseLocalAgentSelection } from "./local-agent-model.js";
describe("native Agent model selection", () => {
  it("preserves old Agent aliases and decodes a model selection canonically", () => {
    expect(parseLocalAgentSelection("native/codex")).toEqual({ engine: "codex" });
    expect(parseLocalAgentSelection("native/workbuddy/deepseek-v4.1-flash")).toEqual({
      engine: "workbuddy",
      modelId: "deepseek-v4.1-flash",
    });
    expect(parseLocalAgentSelection(localAgentModelId("codex", "provider/model:1"))).toEqual({
      engine: "codex",
      modelId: "provider/model:1",
    });
  });
  it.each([
    "native/other/model",
    "native/codex/",
    "native/codex/%",
    "native/codex/a/b",
    "native/workbuddy/%0Amodel",
    "native/codex/%20model",
    "native/workbuddy/model%20",
    "native/codex/%61",
    "native/codex/" + "a".repeat(200),
  ])("rejects malformed or ambiguous selector %s", (id) => {
    expect(parseLocalAgentSelection(id)).toBeUndefined();
  });
});
