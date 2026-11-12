import { beforeEach, describe, expect, it, vi } from "vitest";
import { localDocumentReferences } from "@rakazo/core";
import { verifyNativeDeliveryText } from "./native-delivery-files.js";
const fs = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }));
vi.mock("node:fs/promises", () => fs);
beforeEach(() => { fs.realpath.mockReset(); fs.stat.mockReset(); });
describe("verified native deliveries", () => {
  it("retains a real source path exactly, without copying or guessing another path", async () => {
    fs.realpath.mockResolvedValue("/real/output.docx"); fs.stat.mockResolvedValue({ isFile: () => true });
    const text = "Result\nMEDIA:/work/output.docx";
    expect(await verifyNativeDeliveryText(text)).toBe(text);
  });
  it.each(["MEDIA:/wrong/output.docx", "[报告](/wrong/output.docx)", "`/wrong/output.docx`"])(
    "does not publish a clickable delivery for a nonexistent file: %s", async text => {
      fs.realpath.mockRejectedValue(new Error("ENOENT"));
      const result = await verifyNativeDeliveryText(text);
      expect(localDocumentReferences(result)).toEqual([]);
      expect(result).toContain("文件未交付"); expect(result).toContain("文件尚未成功交付");
      expect(fs.realpath).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a directory named like a file", async () => {
    fs.realpath.mockResolvedValue("/work/report.docx"); fs.stat.mockResolvedValue({ isFile: () => false });
    expect(await verifyNativeDeliveryText("MEDIA:/work/report.docx")).toContain("文件未交付");
  });
  it("keeps valid deliveries when one file is unavailable", async () => {
    fs.realpath.mockImplementation(async p => { if (p === "/work/a.docx") return p; throw Error("ENOENT"); });
    fs.stat.mockResolvedValue({ isFile: () => true });
    const result = await verifyNativeDeliveryText("MEDIA:/work/a.docx\nMEDIA:/wrong/b.docx");
    expect(localDocumentReferences(result).map(r => r.path)).toEqual(["/work/a.docx"]);
  });
});
