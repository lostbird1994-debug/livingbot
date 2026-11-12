-- Connectors a run may reach, chosen per message in the composer.
-- Empty is the default and means none: installing a connector no longer puts its
-- tools in every bot's context.
ALTER TABLE "runs" ADD COLUMN "connectorScope" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
