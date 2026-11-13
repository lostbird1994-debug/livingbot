import { createRouterClient, implement } from "@orpc/server";
import type { Actor } from "@livingbot/contracts";
import { appContract } from "@livingbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { memoryRoutes } from "./memory.js";

function setup() {
  const doc = {
    id: "doc",
    scope: "bot",
    botId: "bot-1",
    path: "MEMORY.md",
    content: "current",
    revision: 5,
  };
  const findDocument = vi.fn().mockResolvedValue(doc);
  const findRevision = vi.fn().mockResolvedValue({ revision: 2, content: "old text" });
  const commit = vi.fn().mockResolvedValue({ ...doc, content: "old text", revision: 6 });
  const authed = implement(appContract).$context<{ actor: Actor }>();
  const router = memoryRoutes({
    authed,
    deps: {
      prisma: {
        memoryDocument: { findFirst: findDocument },
        memoryRevision: { findFirst: findRevision },
      },
      memory: { commit },
    },
  } as unknown as RouterContext);
  const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
  return {
    client: createRouterClient(router, { context: { actor } }),
    findDocument,
    findRevision,
    commit,
  };
}

describe("memory versions", () => {
  it("previews one revision after checking the document owner", async () => {
    const { client, findDocument, findRevision, commit } = setup();
    await expect(client.memory.revision({ documentId: "doc", revision: 2 })).resolves.toEqual({
      revision: 2,
      content: "old text",
    });
    expect(findDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc", spaceId: "space-1", userId: "user-1" },
      }),
    );
    expect(findRevision).toHaveBeenCalledWith({ where: { documentId: "doc", revision: 2 } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not read another owner's revision", async () => {
    const { client, findDocument, findRevision } = setup();
    findDocument.mockResolvedValue(null);
    await expect(
      client.memory.revision({ documentId: "other-doc", revision: 2 }),
    ).rejects.toThrow();
    expect(findRevision).not.toHaveBeenCalled();
  });

  it("rejects a restore based on an unseen current revision", async () => {
    const { client, commit, findRevision } = setup();
    await expect(
      client.memory.restore({ documentId: "doc", revision: 2, expectedRevision: 4 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commit).not.toHaveBeenCalled();
    expect(findRevision).not.toHaveBeenCalled();
  });

  it("restores as a new revision using the caller's expected revision", async () => {
    const { client, commit } = setup();
    await expect(
      client.memory.restore({ documentId: "doc", revision: 2, expectedRevision: 5 }),
    ).resolves.toMatchObject({ content: "old text", revision: 6 });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 5,
        content: "old text",
      }),
      expect.anything(),
    );
  });

  it("requires expectedRevision at the RPC boundary", async () => {
    const { client, commit } = setup();
    await expect(
      client.memory.restore({ documentId: "doc", revision: 2 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(commit).not.toHaveBeenCalled();
  });
});
