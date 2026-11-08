ALTER TABLE routines ADD COLUMN "sharedMemoryOrganizer" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX routines_shared_memory_organizer_key
ON routines ("spaceId", "userId") WHERE "sharedMemoryOrganizer" = true;
