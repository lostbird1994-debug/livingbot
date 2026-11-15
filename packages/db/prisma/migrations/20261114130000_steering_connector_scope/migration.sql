-- Preserve explicitly selected capabilities on messages sent during a run.
ALTER TABLE "steering_messages" ADD COLUMN "connectorScope" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
