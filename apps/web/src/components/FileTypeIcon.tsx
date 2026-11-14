import { cn } from "@livingbot/ui-web/lib/utils";
import type { LucideIcon } from "lucide-react";
import {
  BookText,
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileText,
  Presentation,
  Table2,
} from "lucide-react";

/**
 * The family a file belongs to. Each family owns one glyph and one tint, so a
 * list of names reads at a glance instead of every row carrying the same page.
 */
export type FileKind =
  | "sheet"
  | "doc"
  | "pdf"
  | "slide"
  | "data"
  | "code"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "file";

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  // Sheets
  xls: "sheet",
  xlsx: "sheet",
  xlsm: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  // Documents
  doc: "doc",
  docx: "doc",
  odt: "doc",
  pages: "doc",
  rtf: "doc",
  md: "doc",
  markdown: "doc",
  txt: "doc",
  pdf: "pdf",
  // Slides
  ppt: "slide",
  pptx: "slide",
  key: "slide",
  odp: "slide",
  // Data and code
  json: "data",
  jsonl: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  xml: "data",
  py: "code",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  sql: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  html: "code",
  css: "code",
  // Images and media
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  avif: "image",
  heic: "image",
  bmp: "image",
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
  // Archives
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
};

// Only for names without a useful extension (uploads carrying just a MIME type).
// Order matters: the specific text types come before the bare `text/`.
const KIND_BY_MIME: Array<[string, FileKind]> = [
  ["image/", "image"],
  ["video/", "video"],
  ["audio/", "audio"],
  ["application/pdf", "pdf"],
  ["application/zip", "archive"],
  ["text/html", "code"],
  ["text/csv", "sheet"],
  ["text/markdown", "doc"],
  ["text/", "doc"],
];

const ICONS: Record<FileKind, LucideIcon> = {
  sheet: Table2,
  doc: FileText,
  pdf: BookText,
  slide: Presentation,
  data: FileBraces,
  code: FileCode,
  image: FileImage,
  audio: FileMusic,
  video: FilePlay,
  archive: FileArchive,
  file: File,
};

// Office's own hues, pulled to one weight so the set reads as a family. The dark
// theme lifts each one so it stays legible on the near-black surface.
const COLORS: Record<FileKind, string> = {
  sheet: "text-file-sheet",
  doc: "text-file-document",
  pdf: "text-file-pdf",
  slide: "text-file-slide",
  data: "text-file-code",
  code: "text-file-code",
  image: "text-file-image",
  audio: "text-file-media",
  video: "text-file-media",
  archive: "text-file-archive",
  file: "text-muted-foreground",
};

export function fileKind(name: string, mimeType?: string | null): FileKind {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const byName = KIND_BY_EXTENSION[extension];
  if (byName) return byName;
  if (mimeType) {
    const match = KIND_BY_MIME.find(([prefix]) => mimeType.startsWith(prefix));
    if (match) return match[1];
  }
  return "file";
}

export function fileTypeIcon(name: string, mimeType?: string | null): LucideIcon {
  return ICONS[fileKind(name, mimeType)];
}

export function fileTypeColor(name: string, mimeType?: string | null): string {
  return COLORS[fileKind(name, mimeType)];
}

export function FileTypeIcon({
  name,
  mimeType,
  size,
  className,
}: {
  name: string;
  mimeType?: string | null;
  size?: number;
  className?: string;
}) {
  const kind = fileKind(name, mimeType);
  const Icon = ICONS[kind];
  return <Icon aria-hidden="true" size={size} className={cn(COLORS[kind], className)} />;
}
