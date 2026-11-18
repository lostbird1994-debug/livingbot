-- Records how a revision was settled, so an audit can tell "reviewed in full" from
-- "settled because this run produced the revision". Additive and nullable.
ALTER TABLE "memory_document_checks" ADD COLUMN "settledBy" TEXT;
