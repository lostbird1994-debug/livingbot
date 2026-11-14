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
import { describe, expect, it } from "vitest";
import { fileKind, fileTypeColor, fileTypeIcon } from "./FileTypeIcon";

describe("fileTypeIcon", () => {
  it("reads the kind of file from its extension", () => {
    expect(fileTypeIcon("sample-data.xlsx")).toBe(Table2);
    expect(fileTypeIcon("sample-report.md")).toBe(FileText);
    expect(fileTypeIcon("month-end.pdf")).toBe(BookText);
    expect(fileTypeIcon("journal_diff_detail.json")).toBe(FileBraces);
    expect(fileTypeIcon("report.py")).toBe(FileCode);
    expect(fileTypeIcon("screenshot.png")).toBe(FileImage);
    expect(fileTypeIcon("deliverables.zip")).toBe(FileArchive);
    expect(fileTypeIcon("walkthrough.mp4")).toBe(FilePlay);
    expect(fileTypeIcon("voice-note.m4a")).toBe(FileMusic);
    expect(fileTypeIcon("board deck.key")).toBe(Presentation);
  });

  it("ignores case and directories in the name", () => {
    expect(fileTypeIcon("INVOICE.XLSX")).toBe(Table2);
    expect(fileTypeIcon("work/journal_diff_20261114.json")).toBe(FileBraces);
  });

  it("falls back to the MIME type when the name carries no extension", () => {
    expect(fileTypeIcon("upload", "image/png")).toBe(FileImage);
    expect(fileTypeIcon("upload", "audio/mpeg")).toBe(FileMusic);
    expect(fileTypeIcon("upload", "application/pdf")).toBe(BookText);
  });

  it("keeps an unknown or dotless name a plain file", () => {
    expect(fileTypeIcon(".env")).toBe(File);
    expect(fileTypeIcon("Makefile")).toBe(File);
    expect(fileTypeIcon("notes.dwg")).toBe(File);
  });
});

describe("fileKind", () => {
  it("separates the families that used to share one page", () => {
    expect(fileKind("ledger.xlsx")).toBe("sheet");
    expect(fileKind("report.md")).toBe("doc");
    expect(fileKind("month-end.pdf")).toBe("pdf");
    expect(fileKind("deck.pptx")).toBe("slide");
    expect(fileKind("journal.json")).toBe("data");
    expect(fileKind("report.py")).toBe("code");
    expect(fileKind("shot.png")).toBe("image");
    expect(fileKind("walkthrough.mp4")).toBe("video");
    expect(fileKind("voice.m4a")).toBe("audio");
    expect(fileKind("deliverables.zip")).toBe("archive");
    expect(fileKind("unknown.dwg")).toBe("file");
  });

  it("gives each family its own tint, and leaves unknown files quiet", () => {
    const sheet = fileTypeColor("ledger.xlsx");
    const doc = fileTypeColor("report.md");
    const pdf = fileTypeColor("month-end.pdf");
    expect(new Set([sheet, doc, pdf]).size).toBe(3);
    expect(sheet).toMatch(/^text-/);
    expect(fileTypeColor("unknown.dwg")).toBe("text-muted-foreground");
  });
});
