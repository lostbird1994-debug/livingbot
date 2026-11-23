import assert from "node:assert/strict";
import test from "node:test";
import { previewOpenClawContext } from "./context-preview.ts";

test("context preview uses OpenClaw's bootstrap excerpts and configured budgets", async () => {
  let received: Record<string, unknown> | undefined;
  const preview = await previewOpenClawContext({
    kernelEntry: "/synthetic/openclaw.mjs",
    config: { agents: { defaults: { bootstrapMaxChars: 8000, bootstrapTotalMaxChars: 32000 } } },
    agentId: "bot-example",
    workspace: "/synthetic/workspaces/bot-example",
    resolve: async (options) => {
      received = options;
      return {
        bootstrapFiles: [
          { name: "AGENTS.md", path: "/synthetic/workspaces/bot-example/AGENTS.md", content: "full instructions", missing: false },
          { name: "MEMORY.md", path: "/synthetic/workspaces/bot-example/MEMORY.md", missing: true },
        ],
        contextFiles: [
          { path: "/synthetic/workspaces/bot-example/AGENTS.md", content: "actual loaded excerpt" },
        ],
      };
    },
  });

  assert.deepEqual(received, {
    workspaceDir: "/synthetic/workspaces/bot-example",
    config: { agents: { defaults: { bootstrapMaxChars: 8000, bootstrapTotalMaxChars: 32000 } } },
    agentId: "bot-example",
    contextMode: "full",
    runKind: "default",
  });
  assert.deepEqual(preview.budgets, { document: 8000, total: 32000 });
  assert.deepEqual(preview.documents, [{
    path: "/synthetic/workspaces/bot-example/AGENTS.md",
    name: "AGENTS.md",
    scope: "bot",
    content: "full instructions",
    excerpt: "actual loaded excerpt",
    totalChars: 17,
    shownChars: 21,
  }]);
});
