import { describe, expect, it } from "vitest";
import { nativeBotAgentId, planBotWorkspace, planSharedWorkspace } from "./openclaw-workspace.js";
import type { WorkspaceSourceDocument } from "./openclaw-workspace.js";
const bot = {
  id: "bot", spaceId: "space", name: "Example", instructions: "Do the work",
  roleCard: { identity: "Librarian", personality: "Patient", userIdentity: "A visitor", backstory: "Legacy material" },
};
const doc = (path: string, overrides: Partial<WorkspaceSourceDocument> = {}): WorkspaceSourceDocument => ({
  id: path, scope: "bot", botId: bot.id, path, content: `Source: ${path}`, revision: 3, ...overrides,
});
describe("native workspace migration plan", () => {
  it("preserves private content and legacy material without loading shared data into private files", () => {
    const plan = planBotWorkspace(bot, [
      doc("MEMORY.md"), doc("feishu/process.md"), doc("bot:MEMORY.md"),
      doc("memory/archive/old.md"),
      doc("MEMORY.md", { id: "shared", scope: "user", botId: null, content: "Shared" }),
      doc("other.md", { botId: "other" }),
    ]);
    expect(plan.files["AGENTS.md"]).toBe("Do the work");
    expect(plan.files["USER.md"]).toBe("A visitor");
    expect(plan.files["memory/legacy-role-card.md"]).toBe("Legacy material");
    expect(plan.files["MEMORY.md"]).toBe("Source: MEMORY.md");
    expect(plan.files["memory/feishu/process.md"]).toBe("Source: feishu/process.md");
    expect(Object.keys(plan.files).filter(path => path.startsWith(".rakazo/memory-archive/"))).toHaveLength(2);
    expect(plan.sources).toHaveLength(4);
    expect(Object.values(plan.files)).not.toContain("Shared");
    expect(Object.values(plan.files)).not.toContain("Source: other.md");
  });
  it("rejects escaping paths and preserves colliding sources under distinct mapped names", () => {
    expect(() => planBotWorkspace(bot, [doc("../USER.md")])).toThrow("Unsafe");
    const plan = planBotWorkspace(bot, [doc("memory.md"), doc("MEMORY.md")]);
    expect(plan.files["MEMORY.md"]).toBe("Source: MEMORY.md");
    expect(plan.sources).toHaveLength(2);
    expect(new Set(plan.sources.map(source => source.path)).size).toBe(2);
    expect(() => planBotWorkspace(bot, [doc("/tmp/other.md")])).toThrow("Unsafe");
  });
  it("keeps workspace sharing and agent identities separate", () => {
    expect(nativeBotAgentId("one", "bot")).not.toBe(nativeBotAgentId("two", "bot"));
    expect(nativeBotAgentId("one", "bot")).not.toBe(nativeBotAgentId("one", "other"));
    const shared = planSharedWorkspace([doc("MEMORY.md", { scope: "user", botId: null }), doc("private.md")]);
    expect(Object.keys(shared.files)).toEqual(["MEMORY.md"]);
    expect(shared.sources).toHaveLength(1);
  });
});
