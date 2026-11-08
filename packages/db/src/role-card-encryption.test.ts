import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { botRoleCard } from "@rakazo/contracts";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { contentEncryptionOf, withContentEncryption } from "./content-encryption.js";
import type { SpaceKeyStore } from "./content-keys.js";
import { ContentKeyRing, LocalKeyProvider } from "./content-keys.js";

it("seals role cards at rest, opens selected results and binds ciphertext to its bot", async () => {
  const provider = new LocalKeyProvider([{ id: "master", key: randomBytes(32) }]);
  const key = {
    id: "key",
    spaceId: "space",
    version: 1,
    ...(await provider.wrap(randomBytes(32), { spaceId: "space", version: 1 })),
  };
  const store: SpaceKeyStore = {
    forSpace: async () => [key],
    byId: async () => key,
    insert: async (record) => record,
    rowContext: async () => ({ spaceId: "space", owner: "user" }),
    sampleByMasterKey: async () => [],
  };
  const ring = new ContentKeyRing(provider, store);
  const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
  let written: Record<string, unknown> = {};
  const prisma = withContentEncryption(
    new PrismaClient({ adapter: new PrismaPg(pool) }),
    ring,
  ).$extends({
    query: {
      bot: {
        async create({ args }) {
          written = { ...args.data };
          return { ...args.data };
        },
      },
    },
  });
  try {
    const roleCard = botRoleCard({
      userIdentity: "Private character notes",
      userIdentityEnabled: true,
    });
    const row = await prisma.bot.create({
      data: {
        id: "bot",
        name: "Example",
        color: "ink",
        spaceId: "space",
        userId: "user",
        roleCard,
      },
    });
    expect(row.roleCard).toEqual(roleCard);
    expect(JSON.stringify(written.roleCard)).not.toContain("Private character notes");
    expect(written.roleCard).not.toEqual(roleCard);
    await expect(
      contentEncryptionOf(prisma)!.openRows("Bot", [{ ...written, id: "different-bot" }]),
    ).rejects.toThrow();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
});
