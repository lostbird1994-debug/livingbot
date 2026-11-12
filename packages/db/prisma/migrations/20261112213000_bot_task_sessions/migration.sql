-- Additive: legacy main threads and their unique botId remain unchanged.
BEGIN;
ALTER TABLE threads ADD COLUMN "taskBotId" TEXT REFERENCES bots(id) ON DELETE RESTRICT;
ALTER TABLE threads DROP CONSTRAINT threads_owner_chk;
ALTER TABLE threads ADD CONSTRAINT threads_owner_chk CHECK (num_nonnulls("botId", "groupId", "externalConversationId", "taskBotId") = 1);
CREATE INDEX threads_task_bot_idx ON threads("taskBotId");
ALTER TABLE runs ADD COLUMN "taskSlotHeld" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN "resourceWaitReason" TEXT;
CREATE TABLE bot_task_sessions (
  id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
  "userId" TEXT NOT NULL, "botId" TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  "mainThreadId" TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
  "threadId" TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE RESTRICT,
  title TEXT NOT NULL, "contextSnapshot" TEXT, "clientNonce" TEXT NOT NULL,
  "modelProvider" TEXT, "modelId" TEXT, "thinkingLevel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "archivedAt" TIMESTAMP(3),
  UNIQUE ("botId", "clientNonce")
);
CREATE INDEX bot_task_sessions_owner_idx ON bot_task_sessions("spaceId", "userId", "botId", "updatedAt");
CREATE TABLE task_session_receipts (
  "runId" TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  "taskSessionId" TEXT NOT NULL REFERENCES bot_task_sessions(id) ON DELETE RESTRICT,
  "messageId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE bot_task_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_task_sessions_tenant ON bot_task_sessions USING (
 "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY bot_task_sessions_system ON bot_task_sessions USING (current_setting('app.rls_bypass', true) = 'on');
ALTER TABLE task_session_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_session_receipts_tenant ON task_session_receipts USING (EXISTS (
 SELECT 1 FROM bot_task_sessions s WHERE s.id = "taskSessionId"));
CREATE POLICY task_session_receipts_system ON task_session_receipts USING (current_setting('app.rls_bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON bot_task_sessions, task_session_receipts TO rakazo_app;
COMMIT;
