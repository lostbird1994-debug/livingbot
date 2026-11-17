ALTER TABLE "routines" ADD COLUMN "builtinKind" TEXT, ADD COLUMN "organizationFullCheckedAt" TIMESTAMP(3);
ALTER TABLE "runs" ADD COLUMN "dailyReviewBatch" JSONB;
UPDATE "routines" SET "builtinKind" = 'memory-organization' WHERE "memoryMaintenance" = true;
CREATE UNIQUE INDEX "routines_builtin_bot_member_key" ON "routines" ("spaceId", "botId", "userId", "builtinKind");
CREATE INDEX "runs_daily_review_work_idx" ON "runs" ("spaceId", "userId", "botId", "completedAt", "id");
