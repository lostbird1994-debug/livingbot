import { describe, expect, it } from "vitest";
import { artifactKind, artifactLabel } from "./artifact-kind";

describe("artifactKind", () => {
  it("reads the file's own extension before a generic media type", () => {
    expect(artifactKind("application/octet-stream", "成本核算.xlsx")).toBe("sheet");
    expect(artifactKind("application/octet-stream", "合同明细.pptx")).toBe("slide");
    expect(artifactKind("application/octet-stream", "修复记录.md")).toBe("text");
    expect(artifactKind("application/octet-stream", "image.png")).toBe("image");
  });

  it("recognises long vendor media types when the name has no extension", () => {
    expect(
      artifactKind(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "合同明细",
      ),
    ).toBe("slide");
    expect(
      artifactKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "台账"),
    ).toBe("sheet");
    expect(
      artifactKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "函"),
    ).toBe("word");
  });

  it("uses the media type when the name carries no usable extension", () => {
    expect(artifactKind("image/jpeg", "photo")).toBe("image");
    expect(artifactKind("application/pdf", "scan")).toBe("pdf");
    expect(artifactKind("audio/mpeg", "note")).toBe("audio");
    expect(artifactKind("text/html", "page")).toBe("code");
    expect(artifactKind("text/markdown", "page")).toBe("text");
    expect(artifactKind("application/octet-stream", "blob")).toBe("file");
  });

  it("does not mistake a timestamp in the name for an extension", () => {
    expect(artifactKind("application/octet-stream", "明细_202611111716276383")).toBe("file");
  });
});

describe("artifactLabel", () => {
  it("shows the extension rather than a truncated vendor string", () => {
    expect(
      artifactLabel(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "无锡鲲弘在手合同明细_202611.pptx",
      ),
    ).toBe("PPTX");
    expect(artifactLabel("application/octet-stream", "image.png")).toBe("PNG");
    expect(artifactLabel("text/markdown", "SAP连不上-原因与修复记录.md")).toBe("MD");
  });

  it("falls back to a short media type, never to an unreadable slice", () => {
    expect(artifactLabel("application/pdf", "scan")).toBe("PDF");
    expect(artifactLabel("text/html", "page")).toBe("HTML");
    expect(artifactLabel("application/octet-stream", "blob")).toBe("FILE");
    expect(artifactLabel("application/vnd.ms-excel", "台账")).toBe("XLS");
  });
});
