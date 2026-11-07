const DOCUMENT_EXTENSIONS =
  "docx?|xlsx?|pptx?|pdf|csv|tsv|txt|md|json|html?|png|jpe?g|gif|webp|svg|heic|mp3|wav|mp4|mov";
const documentEnd = new RegExp(`\\.(?:${DOCUMENT_EXTENSIONS})$`, "i");

/** Local document references, never URLs, commands, or executable applications. */
export function localDocumentPath(value: string): string | undefined {
  let path = value.replace(/^MEDIA:\s*/i, "").trim();
  try {
    if (path.startsWith("file:")) {
      const url = new URL(path);
      if (
        url.protocol !== "file:" ||
        (url.hostname && url.hostname !== "localhost") ||
        url.search ||
        url.hash
      )
        return;
      path = decodeURIComponent(url.pathname);
    } else if (/%[\da-f]{2}/i.test(path)) path = decodeURIComponent(path);
  } catch {
    return;
  }
  if (
    (!path.startsWith("/") && !path.startsWith("~/")) ||
    path.startsWith("//") ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !documentEnd.test(path)
  )
    return;
  return path;
}

/**
 * Whether a bare file name is something `open` may launch. Attachments are named by the
 * bot, so a name without one of these extensions is never handed to the launcher.
 */
export function isLocalDocumentName(name: string): boolean {
  return (
    documentEnd.test(name) &&
    ![...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

/** Keep offsets so Markdown can replace just the reference, not nearby prose. */
export function localDocumentReferences(
  text: string,
): { start: number; end: number; path: string }[] {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_:/])(?:MEDIA:\\s*)?(?:file:///(?!/)|~/|/(?!/))[^\\r\\n\x60"'<>]*?\\.(?:${DOCUMENT_EXTENSIONS})(?=$|[\\s\x60"'<>),，。；;:：!?！？\\]])`,
    "giu",
  );
  return [...text.matchAll(pattern)].flatMap((match) => {
    const path = localDocumentPath(match[0]);
    return path ? [{ start: match.index, end: match.index + match[0].length, path }] : [];
  });
}
