import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { localDocumentReferences } from "@rakazo/core";

/** A model-written path is not a delivery receipt. Verify before publishing it. */
export async function verifyNativeDeliveryText(text: string): Promise<string> {
  const missing: string[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const ref of localDocumentReferences(text)) {
    const requested = ref.path.startsWith("~/") ? join(homedir(), ref.path.slice(2)) : ref.path;
    try {
      const path = await realpath(requested);
      if (!(await stat(path)).isFile()) throw new Error("Not a file");
    } catch {
      let { start, end } = ref;
      const markdown = text.slice(0, start).match(/\[[^\]\n]*\]\($/);
      if (markdown && text[end] === ")") { start -= markdown[0].length; end++; }
      const name = basename(ref.path).replace(/[\[\]`]/g, "");
      replacements.push({ start, end, value: `文件未交付：${name}（路径不可用）` });
      missing.push(name);
    }
  }
  for (const item of replacements.reverse())
    text = text.slice(0, item.start) + item.value + text.slice(item.end);
  if (missing.length)
    text += "\n\nRakazo 提示：上述文件路径未通过核验，文件尚未成功交付。需要提供真实文件后重新交付。";
  return text;
}
