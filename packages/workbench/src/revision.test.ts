import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { applyAnchoredRevision, assertRevisionBase } from "./revision.ts";

const synthetic = [
  "# 合成合同", "", "## 付款", "分三期支付，首期 30%。", "", "## 交付", "3 月 1 日交付。", "", "## 违约", "按日计罚。",
].join("\n");

test("only the located passage changes and the rest stays byte-identical", () => {
  const { text, receipt } = applyAnchoredRevision(synthetic, "首期 30%", "首期 20%");
  assert.equal(text, synthetic.replace("首期 30%", "首期 20%"));
  assert.equal(text.slice(0, receipt.start), synthetic.slice(0, receipt.start));
  assert.equal(text.slice(receipt.start + "首期 20%".length), synthetic.slice(receipt.end));
  assert.equal(receipt.removed, "首期 30%");
  assert.equal(receipt.inserted, "首期 20%");
  assert.ok(text.includes("## 交付") && text.includes("按日计罚"));
});

test("a passage that appears twice is refused instead of edited arbitrarily", () => {
  const duplicated = `${synthetic}\n分三期支付，首期 30%。`;
  assert.throws(() => applyAnchoredRevision(duplicated, "首期 30%", "首期 20%"), /more than once/);
});

test("a missing or empty passage is refused", () => {
  assert.throws(() => applyAnchoredRevision(synthetic, "首期 10%", "首期 20%"), /does not appear/);
  assert.throws(() => applyAnchoredRevision(synthetic, "", "x"), /needs a located passage/);
});

test("line endings and surrounding content survive a revision", () => {
  const crlf = "第一段\r\n第二段：原值\r\n第三段\r\n";
  const { text } = applyAnchoredRevision(crlf, "原值", "新值");
  assert.equal(text, "第一段\r\n第二段：新值\r\n第三段\r\n");
});

test("a stale base is refused", () => {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const base = digest(synthetic);
  assert.doesNotThrow(() => assertRevisionBase(synthetic, base, digest));
  assert.throws(() => assertRevisionBase(`${synthetic}\n新增`, base, digest), /changed since it was reviewed/);
});
