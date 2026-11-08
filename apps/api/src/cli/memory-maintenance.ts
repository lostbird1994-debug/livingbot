import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  configureMemoryMaintenance,
  contentKeyProviderFromEnv,
  enableAutomaticMemoryOrganization,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { isMemoryReviewPath } from "@rakazo/contracts";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  backfillMemorySearch,
  contentEncryptionOf,
  createDb,
  MEMORY_SEARCH_VERSION,
  normalizeMemorySearch,
  runAsSystem,
} from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";

loadRootEnv();
await unwrapEnvFromKeyManager();
const command = process.argv[2];
if (
  ![
    "backfill-search",
    "verify-search",
    "check-search",
    "plan-nightly",
    "enable-nightly",
    "enable-auto",
  ].includes(command ?? "")
)
  throw new Error(
    "Use backfill-search, verify-search, check-search, plan-nightly, enable-nightly or enable-auto.",
  );
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const { prisma, pool } = createDb(process.env.DATABASE_URL, {
  keyProvider: contentKeyProviderFromEnv(),
});
try {
  const result = await runAsSystem("explicit memory maintenance setup", async () => {
    if (command === "enable-auto") return enableAutomaticMemoryOrganization(prisma);
    if (command === "backfill-search") return backfillMemorySearch(prisma);
    if (command === "verify-search") return verifySearch();
    if (command === "check-search") {
      const versions = await prisma.memoryDocument.groupBy({
        by: ["searchTokensVersion"],
        _count: true,
      });
      const documents = versions.reduce((sum, row) => sum + row._count, 0);
      const unindexed = versions
        .filter((row) => row.searchTokensVersion !== MEMORY_SEARCH_VERSION)
        .reduce((sum, row) => sum + row._count, 0);
      if (unindexed) process.exitCode = 2;
      return {
        expectedVersion: MEMORY_SEARCH_VERSION,
        documents,
        unindexed,
        healthy: unindexed === 0,
      };
    }
    return configureMemoryMaintenance(prisma, command === "enable-nightly");
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await prisma.$disconnect();
  await pool.end();
}

async function verifySearch() {
  const memory = new MarkdownMemoryStore(prisma);
  const groups = await prisma.memoryDocument.findMany({
    distinct: ["spaceId", "userId", "scope", "botId"],
    select: { spaceId: true, userId: true, scope: true, botId: true },
  });
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Verification requires the production encryption extension.");
  const openRows = encryption.openRows.bind(encryption);
  let candidates = 0;
  let baseline = 0;
  let queries = 0;
  encryption.openRows = async (model, rows) => {
    if (model === "MemoryDocument") candidates += rows.length;
    return openRows(model, rows);
  };
  try {
    for (const group of groups) {
      const request = { scope: group.scope as "bot" | "user", botId: group.botId ?? undefined };
      const context: AdapterContext = {
        spaceId: group.spaceId,
        userId: group.userId,
        botId: group.botId ?? undefined,
        operationId: "verify-memory-search",
        traceId: "verify-memory-search",
        signal: new AbortController().signal,
      };
      const snapshot = await memory.read(request, context);
      const documents = snapshot.documents.filter((doc) => !isMemoryReviewPath(doc.path));
      const samples = new Set([
        "导账",
        "账",
        "流程",
        "WORK",
        "nonexistent-memory-verification-needle",
      ]);
      for (const document of documents) {
        const text = Array.from(normalizeMemorySearch(document.content));
        if (document.path.length <= 500) samples.add(document.path);
        for (const fraction of [0.25, 0.5, 0.75]) {
          const query = text
            .slice(Math.floor(text.length * fraction), Math.floor(text.length * fraction) + 3)
            .join("")
            .trim();
          if (query) samples.add(query);
        }
      }
      for (const query of samples) {
        const q = normalizeMemorySearch(query.trim());
        const expected = documents
          .filter(
            (doc) =>
              normalizeMemorySearch(doc.content).includes(q) ||
              normalizeMemorySearch(doc.path).includes(q),
          )
          .map((doc) => doc.path)
          .sort();
        const actual = (await memory.search({ ...request, query }, context))
          .map((hit) => hit.path)
          .sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual))
          throw new Error(
            "Indexed search differs from a complete normalized scan; source text withheld.",
          );
        queries += 1;
        baseline += documents.length;
      }
    }
  } finally {
    encryption.openRows = openRows;
  }
  return {
    queries,
    baselineDecryptions: baseline,
    candidateDecryptions: candidates,
    equivalent: true,
  };
}
