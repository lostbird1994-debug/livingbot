/**
 * What kind of file an artifact is, for the list icon and the badge beside it.
 *
 * The stored media type is often generic (`application/octet-stream`) or a long vendor string
 * (`application/vnd.openxmlformats-…presentation`), so the file's own extension is the better
 * signal and the media type is only the fallback.
 */
export type ArtifactKind =
  | "image"
  | "pdf"
  | "word"
  | "sheet"
  | "slide"
  | "code"
  | "text"
  | "video"
  | "audio"
  | "archive"
  | "file";

const EXTENSION_KINDS: Record<string, ArtifactKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  heic: "image",
  bmp: "image",
  svg: "image",
  pdf: "pdf",
  doc: "word",
  docx: "word",
  rtf: "word",
  odt: "word",
  pages: "word",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  tsv: "sheet",
  ods: "sheet",
  numbers: "sheet",
  ppt: "slide",
  pptx: "slide",
  odp: "slide",
  key: "slide",
  md: "text",
  markdown: "text",
  txt: "text",
  log: "text",
  html: "code",
  htm: "code",
  css: "code",
  js: "code",
  mjs: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  json: "code",
  py: "code",
  rs: "code",
  go: "code",
  java: "code",
  sh: "code",
  sql: "code",
  yml: "code",
  yaml: "code",
  toml: "code",
  xml: "code",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  flac: "audio",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  rar: "archive",
  "7z": "archive",
};

const MIME_KINDS: [match: string, kind: ArtifactKind][] = [
  ["wordprocessingml", "word"],
  ["msword", "word"],
  ["spreadsheetml", "sheet"],
  ["ms-excel", "sheet"],
  ["presentationml", "slide"],
  ["ms-powerpoint", "slide"],
  ["javascript", "code"],
  ["json", "code"],
  ["xml", "code"],
  ["zip", "archive"],
];

const MIME_LABELS: Record<string, string> = {
  "text/html": "HTML",
  "text/markdown": "MD",
  "text/plain": "TXT",
  "text/csv": "CSV",
  "application/pdf": "PDF",
  "application/json": "JSON",
  "application/zip": "ZIP",
  "application/msword": "DOC",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
};

/** Only a short alphanumeric tail counts; "20261111171627" after a dot is part of the name. */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(extension) ? extension : "";
}

function kindFromMime(mimeType: string): ArtifactKind {
  const mime = mimeType.toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "text/csv") return "sheet";
  if (mime === "text/html") return "code";
  // Everything else readable as text — markdown, plain text, source — is its own kind.
  if (mime.startsWith("text/")) return "text";
  for (const [match, kind] of MIME_KINDS) if (mime.includes(match)) return kind;
  return "file";
}

export function artifactKind(mimeType: string, name: string): ArtifactKind {
  return EXTENSION_KINDS[fileExtension(name)] ?? kindFromMime(mimeType);
}

/** The badge text: the file's own extension when it has one, otherwise a short media type. */
export function artifactLabel(mimeType: string, name: string): string {
  const extension = fileExtension(name);
  if (extension) return extension.toUpperCase();
  const mime = mimeType.toLowerCase();
  const known = MIME_LABELS[mime];
  if (known) return known;
  const slash = mime.indexOf("/");
  const tail = slash === -1 ? mime : mime.slice(slash + 1);
  const short = tail.split("+")[0]?.replace(/^x-/, "") ?? "";
  return short && short !== "octet-stream" ? short.toUpperCase().slice(0, 6) : "FILE";
}
