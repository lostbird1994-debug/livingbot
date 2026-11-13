import type { MemoryStore } from "@livingbot/adapter-kit";
import { botRoleCard, excludesSharedProfile } from "@livingbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { previewAgentMemoryContext } from "./memory-context.js";
import { runIdentityInstruction } from "./run-instructions.js";

describe("role card runtime context", () => {
  it("loads filled user identity and omits the retired backstory module", () => {
    const result = runIdentityInstruction(
      {
        name: "Example",
        description: "Public summary",
        instructions: "Private instruction",
        roleCard: botRoleCard({
          identity: "A fictional librarian",
          personality: "Patient",
          userIdentity: "The visitor",
          backstory: "A remote library",
        }),
      },
      "user",
    );
    expect(result).toContain("Private instruction");
    expect(result).toContain("Bot identity:\nA fictional librarian");
    expect(result).toContain("Personality:\nPatient");
    expect(result).toContain("The visitor");
    expect(result).not.toContain("A remote library");
  });
  it.each(["user", "created", "routine"])(
    "includes user identity and ignores retired switches for %s runs",
    (trigger) => {
      const result = runIdentityInstruction(
        {
          name: "Example",
          roleCard: botRoleCard({
            userIdentityEnabled: true,
            backstoryEnabled: true,
            userIdentity: "The visitor",
            backstory: "A remote library",
          }),
        },
        trigger,
      );
      expect(result).toContain("The visitor");
      expect(result).not.toContain("A remote library");
    },
  );
  it.each(["userIdentityEnabled", "backstoryEnabled"])(
    "keeps shared profiles loaded when retired %s is on",
    async (flag) => {
      const memory = {
        read: vi.fn(async ({ scope }) => ({
          documents: (scope === "bot"
            ? ["MEMORY.md"]
            : ["./USER.md", "memory.md", "PROFILE.md", "memory/reference.md"]
          ).map((path) => ({
            id: scope + path,
            path,
            content: `${scope} source ${path}`,
            revision: 1,
          })),
        })),
      } as unknown as MemoryStore;
      const result = await previewAgentMemoryContext(
        memory,
        "bot",
        {
          spaceId: "space",
          userId: "user",
          botId: "bot",
          operationId: "test",
          traceId: "test",
          signal: new AbortController().signal,
        },
        { excludeSharedProfile: excludesSharedProfile({ [flag]: true }) },
      );
      expect(result.body).toContain("bot source MEMORY.md");
      expect(result.context).toContain("user source");
      expect(result.index).toContain("user:memory/reference.md");
      expect(result.documents.filter((doc) => doc.scope === "user")).toHaveLength(4);
    },
  );
});
