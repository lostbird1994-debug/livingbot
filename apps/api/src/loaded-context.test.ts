import type { MemoryStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
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
  it("previews saved role modules with the executor's shared-profile exclusions", async () => {
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
    expect(result.sharedProfileExcluded).toBe(true);
    expect(result.memory.context).toContain("Private fact");
    expect(result.memory.context).not.toContain("Shared fact");
  });
});
