-- Additive: the previous release can continue reading and writing memory documents.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "memory_documents"
  ADD COLUMN "searchTokens" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "searchTokensVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "memory_documents_searchTokens_idx"
  ON "memory_documents" USING GIN ("searchTokens");

-- A previous release does not know the index fields. Its writes must fall back to
-- decrypted matching rather than leaving apparently valid tokens for old text.
CREATE FUNCTION invalidate_memory_search_tokens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
    AND NEW."searchTokens" IS NOT DISTINCT FROM OLD."searchTokens" THEN
    NEW."searchTokens" := ARRAY[]::INTEGER[];
    NEW."searchTokensVersion" := 0;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_search_invalidate_legacy_write
  BEFORE UPDATE OF content ON memory_documents
  FOR EACH ROW EXECUTE FUNCTION invalidate_memory_search_tokens();

ALTER TABLE "routines" ADD COLUMN "memoryMaintenance" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
