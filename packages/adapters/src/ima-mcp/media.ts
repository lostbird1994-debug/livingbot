/**
 * IMA knowledge-base upload rules: which file types it accepts, their
 * media_type, and the per-type size ceiling enforced before any request.
 * Mirrors the converter the IMA skill ships; impossible or oversized files are
 * rejected locally so nothing is created upstream.
 */

export type MediaProfile = { mediaType: number; contentType: string; fileExt: string };

const MB = 1024 * 1024;

const EXTENSIONS: Readonly<Record<string, { mediaType: number; contentType: string }>> = {
  pdf: { mediaType: 1, contentType: "application/pdf" },
  doc: { mediaType: 3, contentType: "application/msword" },
  docx: {
    mediaType: 3,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  ppt: { mediaType: 4, contentType: "application/vnd.ms-powerpoint" },
  pptx: {
    mediaType: 4,
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  xls: { mediaType: 5, contentType: "application/vnd.ms-excel" },
  xlsx: {
    mediaType: 5,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  csv: { mediaType: 5, contentType: "text/csv" },
  md: { mediaType: 7, contentType: "text/markdown" },
  markdown: { mediaType: 7, contentType: "text/markdown" },
  png: { mediaType: 9, contentType: "image/png" },
  jpg: { mediaType: 9, contentType: "image/jpeg" },
  jpeg: { mediaType: 9, contentType: "image/jpeg" },
  webp: { mediaType: 9, contentType: "image/webp" },
  txt: { mediaType: 13, contentType: "text/plain" },
  xmind: { mediaType: 14, contentType: "application/x-xmind" },
  mp3: { mediaType: 15, contentType: "audio/mpeg" },
  m4a: { mediaType: 15, contentType: "audio/x-m4a" },
  wav: { mediaType: 15, contentType: "audio/wav" },
  aac: { mediaType: 15, contentType: "audio/aac" },
};

const CONTENT_TYPES: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (const entry of Object.values(EXTENSIONS)) {
    map[entry.contentType] ??= entry.mediaType;
  }
  Object.assign(map, {
    "text/x-markdown": 7,
    "application/md": 7,
    "application/markdown": 7,
    "application/vnd.xmind.workbook": 14,
    "application/zip": 14,
  });
  return map;
})();

const SIZE_LIMITS: Readonly<Record<number, number>> = {
  5: 10 * MB,
  7: 10 * MB,
  9: 30 * MB,
  13: 10 * MB,
  14: 10 * MB,
};
const DEFAULT_SIZE_LIMIT = 200 * MB;

export function extensionOf(fileName: string): string {
  const match = /\.([^.\\/]+)$/u.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

export type UploadPlan = { ok: true; profile: MediaProfile } | { ok: false; reason: string };

/** Content type wins when it is one we know; otherwise the extension decides. */
export function planUpload(input: {
  fileName: string;
  size: number;
  contentType?: string;
}): UploadPlan {
  const declared = (input.contentType ?? "").trim().toLowerCase();
  const ext = extensionOf(input.fileName);
  const byType = CONTENT_TYPES[declared];
  const byExt = EXTENSIONS[ext];
  const mediaType = byType ?? byExt?.mediaType;
  if (mediaType === undefined) {
    return {
      ok: false,
      reason: ext
        ? `IMA 不支持 .${ext} 这种文件；支持 PDF、Word、PPT、Excel、Markdown、图片、TXT、Xmind 和录音。`
        : "无法识别文件类型：请给出带扩展名的文件，或一并说明文件的内容类型。",
    };
  }
  const contentType =
    byType !== undefined && declared
      ? declared
      : (byExt?.contentType ?? "application/octet-stream");
  const limit = SIZE_LIMITS[mediaType] ?? DEFAULT_SIZE_LIMIT;
  if (input.size > limit) {
    return {
      ok: false,
      reason: `文件 ${formatSize(input.size)}，超过这类文件 ${formatSize(limit)} 的上限。`,
    };
  }
  return { ok: true, profile: { mediaType, contentType, fileExt: ext } };
}

export function formatSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
