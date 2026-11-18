-- Cross-run memory review progress. Additive only: new table plus one nullable column.
ALTER TABLE "routines" ADD COLUMN "organizationSweepStartedAt" TIMESTAMP(3);

CREATE TABLE "memory_document_checks" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "chars" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "ranges" JSONB NOT NULL DEFAULT '[]',
    "runId" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_document_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_document_checks_documentId_revision_key" ON "memory_document_checks"("documentId", "revision");
CREATE INDEX "memory_document_checks_botId_status_idx" ON "memory_document_checks"("botId", "status");
