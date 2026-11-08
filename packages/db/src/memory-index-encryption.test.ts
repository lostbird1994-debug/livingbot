import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { contentEncryptionOf, withContentEncryption } from "./content-encryption.js";
import type { SpaceKeyStore } from "./content-keys.js";
import { ContentKeyRing, LocalKeyProvider } from "./content-keys.js";

it("indexes scalar memory content and queries both data-key versions", async () => {
  const provider = new LocalKeyProvider([{ id: "m", key: randomBytes(32) }]);
  const records = await Promise.all(
    [1, 2].map(async (version) => ({
      id: `key-${version}`,
      spaceId: "s",
      version,
      ...(await provider.wrap(randomBytes(32), { spaceId: "s", version })),
    })),
  );
  const store: SpaceKeyStore = {
    forSpace: async () => records,
    byId: async (id) => records.find((row) => row.id === id),
    insert: async (record) => record,
    rowContext: async () => ({ spaceId: "s", owner: "u" }),
    sampleByMasterKey: async () => [],
  };
  const ring = new ContentKeyRing(provider, store);
  const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
  let written!: Record<string, unknown>;
  const prisma = withContentEncryption(
    new PrismaClient({ adapter: new PrismaPg(pool) }),
    ring,
  ).$extends({
    query: {
      memoryDocument: {
        async create({ args }) {
          written = { ...args.data };
          return { ...args.data };
        },
      },
    },
  });
  try {
    const doc = await prisma.memoryDocument.create({
      data: { spaceId: "s", userId: "u", scope: "bot", path: "MEMORY.md", content: "月结导账流程" },
    });
    expect(doc.content).toBe("月结导账流程");
    expect(written.content).toMatch(/^rkz1:key-2:/);
    expect(written.searchTokensVersion).toBe(1);
    const query = await contentEncryptionOf(prisma)!.memorySearchTokens("s", "导账");
    expect(query).toHaveLength(2);
    const tokens = new Set(written.searchTokens as number[]);
    expect(query[1]!.every((token) => tokens.has(token))).toBe(true);
    expect(query[0]!.every((token) => tokens.has(token))).toBe(false);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
});
