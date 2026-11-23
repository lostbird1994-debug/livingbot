/**
 * A precise revision changes exactly one located passage. Everything before and
 * after the anchor must stay byte-identical, so an ambiguous or missing anchor
 * is refused instead of silently editing the wrong place.
 */
export type RevisionReceipt = {
  before: number;
  after: number;
  start: number;
  end: number;
  removed: string;
  inserted: string;
};

export function applyAnchoredRevision(source: string, anchor: string, replacement: string): {
  text: string; receipt: RevisionReceipt;
} {
  if (!anchor) throw new Error("A revision needs a located passage");
  if (typeof source !== "string" || typeof replacement !== "string") throw new Error("Invalid revision input");
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error("The located passage does not appear in this revision source");
  if (source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error("The located passage appears more than once; revise a unique passage");
  }
  const text = source.slice(0, first) + replacement + source.slice(first + anchor.length);
  // Verifying the surviving prefix and suffix is what makes "only this passage
  // changed" a checked fact rather than an intention.
  if (text.slice(0, first) !== source.slice(0, first) ||
    text.slice(first + replacement.length) !== source.slice(first + anchor.length)) {
    throw new Error("The revision changed content outside its passage");
  }
  return {
    text,
    receipt: {
      before: source.length, after: text.length, start: first, end: first + anchor.length,
      removed: anchor, inserted: replacement,
    },
  };
}

/** A stale source is any byte-level difference from the reviewed revision base. */
export function assertRevisionBase(current: string, expectedDigest: string, digest: (text: string) => string): void {
  if (digest(current) !== expectedDigest) throw new Error("The document changed since it was reviewed");
}
