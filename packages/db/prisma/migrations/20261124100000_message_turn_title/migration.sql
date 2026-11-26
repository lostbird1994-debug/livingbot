-- The chat's margin lists one short title per turn, written on the message that opened it.
-- Additive and nullable: turns without a title (older turns, routines) fall back to their own text.
ALTER TABLE "messages" ADD COLUMN "turnTitle" TEXT;
