import type { MemoryStore } from "@livingbot/adapter-kit";
import type { Actor } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import { describe, expect, it, vi } from "vitest";
import { loadedBotContext } from "./loaded-context.js";

const actor = { spaceId: "space", userId: "user" } as Actor;
function fixture() {
  const bot = { id: "bot", name: "Example", description: "Helps", instructions: "Be precise." };
  const findFirst = vi.fn().mockResolvedValue(bot);
  const read = vi.fn(async (request: { scope: string }) => ({
    documents: [
      {
        id: `${request.scope}-summary`,
        path: "MEMORY.md",
        revision: 2,
        content: request.scope === "bot" ? "Private fact" : "Shared fact",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  }));
  const findMany = vi.fn().mockResolvedValue([]);
  const deps = {
    prisma: { bot: { findFirst }, scratchpadItem: { findMany } } as unknown as PrismaClient,
    memory: { read } as unknown as MemoryStore,
  };
  return { deps, findFirst, read, findMany };
}
describe("loaded bot context preview", () => {
  it("checks the user, space and active bot before reading private inputs", async () => {
    const { deps, findFirst, read, findMany } = fixture();
    findFirst.mockResolvedValue(null);
    await expect(loadedBotContext(deps, actor, "other")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "other", ...actor, archivedAt: null },
      }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
  it("uses real runtime identity and memory assembly with scoped reads and no writes", async () => {
    const { deps, read } = fixture();
    const result = await loadedBotContext(deps, actor, "bot");
    expect(result.identity).toContain("Example\nHelps");
    expect(result.identity).toContain("Be precise.");
    expect(result.memory.body).toContain("Private fact");
    expect(result.memory.body).toContain("Shared fact");
    expect(result.memory.documents).toHaveLength(2);
    expect(result.scratchpad).toBe("");
    expect(result.budgets).toEqual({ document: 20000, body: 60000, shared: 10000, index: 4000 });
    expect(read).toHaveBeenCalledWith(
      { scope: "bot", botId: "bot" },
      expect.objectContaining({ ...actor, botId: "bot" }),
    );
    expect(read).toHaveBeenCalledWith({ scope: "user" }, expect.objectContaining(actor));
  });
  it("keeps workspace-shared context after retiring the old role switches", async () => {
    const { deps, findFirst } = fixture();
    findFirst.mockResolvedValue({
      id: "bot",
      name: "Example",
      description: "",
      instructions: "",
      roleCard: { identity: "Librarian", userIdentity: "Visitor", userIdentityEnabled: true },
    });
    const result = await loadedBotContext(deps, actor, "bot");
    expect(result.identity).toContain("Librarian");
    expect(result.identity).toContain("Visitor");
    expect(result.sharedProfileExcluded).toBe(false);
    expect(result.memory.context).toContain("Private fact");
    expect(result.memory.context).toContain("Shared fact");
  });
  it("returns the native engine's actual excerpts without assembling a second legacy memory block", async () => {
    const { deps, read } = fixture();
    const native = {
      engine: "openclaw" as const, agentId: "test-agent", workspace: "/synthetic/bot",
      budgets: { document: 12000, total: 60000 },
      documents: [
        { path: "/synthetic/bot/AGENTS.md", name: "AGENTS.md", scope: "bot" as const,
          content: "instructions", excerpt: "instructions", totalChars: 12, shownChars: 12 },
        { path: "/synthetic/shared/MEMORY.md", name: "工作区共享/MEMORY.md", scope: "user" as const,
          content: "long shared memory", excerpt: "short excerpt", totalChars: 18, shownChars: 13 },
      ],
    };
    const preview = vi.fn(async () => native);
    const result = await loadedBotContext({ ...deps, nativeContextPreview: preview }, actor, "bot");
    expect(result.nativeContext).toEqual(native);
    expect(result.identity).toBe("instructions");
    expect(result.memory.body).toBe("short excerpt");
    expect(result.budgets.document).toBe(12000);
    expect(preview).toHaveBeenCalledWith(actor, "bot");
    expect(read).not.toHaveBeenCalled();
  });
});
