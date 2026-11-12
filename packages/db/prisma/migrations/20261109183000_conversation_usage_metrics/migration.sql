ALTER TABLE "usage_records"
  ADD COLUMN "modelDurationMs" INTEGER,
  ADD COLUMN "generationDurationMs" INTEGER,
  ADD COLUMN "contextTokens" INTEGER,
  ADD COLUMN "contextWindow" INTEGER;

CREATE INDEX "usage_records_runId_idx" ON "usage_records"("runId");
CREATE INDEX "usage_records_parentRunId_idx" ON "usage_records"("parentRunId");
