import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { MEMORY_SEARCH_VERSION } from "./memory-search.js";

/** Explicit operator action. Updates derived fields only, with a ciphertext/revision CAS. */
export async function backfillMemorySearch(prisma: PrismaClient) {
  const encryption = contentEncryptionOf(prisma);
  if (!encryption?.ring.encryptWrites)
    throw new Error("Memory index backfill requires content encryption.");
  let cursor = "";
  let indexed = 0;
  let conflicts = 0;
  for (;;) {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        spaceId: string;
        userId: string;
        content: string;
        revision: number;
      }>
    >(Prisma.sql`
      SELECT id, "spaceId", "userId", content, revision FROM memory_documents
      WHERE id > ${cursor} AND "searchTokensVersion" <> ${MEMORY_SEARCH_VERSION}
      ORDER BY id LIMIT 50
    `);
    if (!rows.length) break;
    const plaintext = await encryption.openRows(
      "MemoryDocument",
      rows.map((row) => ({ ...row })),
    );
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const tokens = await encryption.memoryIndexTokens(row.spaceId, plaintext[i]!.content);
      const count = await prisma.$executeRaw(Prisma.sql`
        UPDATE memory_documents
        SET "searchTokens" = ${tokens}::int[], "searchTokensVersion" = ${MEMORY_SEARCH_VERSION}
        WHERE id = ${row.id} AND "spaceId" = ${row.spaceId} AND "userId" = ${row.userId}
          AND revision = ${row.revision} AND content = ${row.content}
          AND "searchTokensVersion" <> ${MEMORY_SEARCH_VERSION}
      `);
      if (count) indexed += 1;
      else conflicts += 1;
    }
    cursor = rows.at(-1)!.id;
  }
  return { indexed, conflicts };
}
