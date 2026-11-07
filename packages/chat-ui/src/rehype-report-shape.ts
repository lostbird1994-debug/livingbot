import type { HastNode } from "./table-utils";

/**
 * Report shape, applied after markdown is parsed:
 *
 * - The opening paragraph of a long reply becomes the lead: it states the outcome,
 *   so it gets its own surface instead of blending into the body.
 * - A section titled as evidence (`## 依据`, `### Verification`, …) folds into a
 *   closed <details>, keeping logs and numbers one click away.
 *
 * Both rules bail out rather than guess: a reply that does not look like a report
 * renders exactly as before.
 */

const EVIDENCE_TERMS = [
  "依据",
  "证据",
  "验证",
  "校验",
  "日志",
  "来源",
  "出处",
  "参考",
  "附录",
  "测试结果",
  "落盘",
  "evidence",
  "verification",
  "verified",
  "logs",
  "log excerpt",
  "sources",
  "reference",
  "proof",
  "test result",
];

/** A lead paragraph is one sentence or two; longer means it is prose, not a summary. */
const LEAD_MAX_CHARS = 160;

/** A label, not a sentence: evidence headings are short. */
const EVIDENCE_LABEL_MAX_CHARS = 16;

/** Beyond this the heading is prose that happens to mention a keyword. */
const EVIDENCE_HEADING_MAX_CHARS = 48;

/** Only fold what clearly reads as evidence, and never more than this many sections. */
const MAX_EVIDENCE_SECTIONS = 2;

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  let text = "";
  for (const child of node.children) text += textOf(child);
  return text;
}

function headingLevel(node: HastNode): number {
  if (node.type !== "element" || !node.tagName || !HEADING_TAGS.has(node.tagName)) return 0;
  return Number(node.tagName.slice(1));
}

function isEvidenceHeading(node: HastNode): boolean {
  const level = headingLevel(node);
  // ## and ### only: an h1 is the document title, an h4 is a detail inside another section.
  if (level < 2 || level > 3) return false;
  const text = textOf(node).toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || text.length > EVIDENCE_HEADING_MAX_CHARS) return false;
  const term = EVIDENCE_TERMS.find((candidate) => text.includes(candidate));
  if (!term) return false;
  // Either it is a short label ("依据", "验证结果") or the keyword opens the line
  // ("Evidence from the three runs"). A full sentence that merely mentions 验证
  // is a normal section, not a log dump.
  return text.length <= EVIDENCE_LABEL_MAX_CHARS || text.startsWith(term);
}

function isBlank(node: HastNode): boolean {
  return node.type === "text" && !(node.value ?? "").trim();
}

/** Index of the first block after `start` that ends the section, or the end of the list. */
function sectionEnd(children: HastNode[], start: number, level: number): number {
  for (let index = start + 1; index < children.length; index += 1) {
    const next = children[index];
    if (!next) continue;
    const candidate = headingLevel(next);
    if (candidate && candidate <= level) return index;
  }
  return children.length;
}

function foldEvidenceSections(tree: HastNode): void {
  const children = tree.children;
  if (!children?.length) return;
  const output: HastNode[] = [];
  let folded = 0;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (!node) continue;
    if (folded >= MAX_EVIDENCE_SECTIONS || !isEvidenceHeading(node)) {
      output.push(node);
      continue;
    }
    const end = sectionEnd(children, index, headingLevel(node));
    const body = children.slice(index + 1, end).filter((child) => !isBlank(child));
    // Nothing to hide: keep the heading inline so the reply reads normally.
    if (!body.length) {
      output.push(node);
      continue;
    }
    output.push({
      type: "element",
      tagName: "details",
      properties: { className: ["rk-evidence"] },
      children: [
        {
          type: "element",
          tagName: "summary",
          properties: {},
          children: [{ type: "text", value: textOf(node).trim() }],
        },
        ...body,
      ],
    });
    folded += 1;
    index = end - 1;
  }
  tree.children = output;
}

function markLeadParagraph(tree: HastNode): void {
  const children = tree.children;
  // Two blocks can be a heading plus one line — too little to call a report.
  if (!children || children.length < 3) return;
  const first = children[0];
  if (first?.type !== "element" || first.tagName !== "p") return;
  const text = textOf(first).trim();
  if (!text || text.length > LEAD_MAX_CHARS) return;
  const properties = first.properties ?? {};
  const existing = properties.className;
  properties.className = [
    ...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []),
    "rk-lead",
  ];
  first.properties = properties;
}

/** @returns A rehype transformer; it runs on the parsed tree, before React renders it. */
export function rehypeReportShape() {
  return (tree: HastNode) => {
    foldEvidenceSections(tree);
    markLeadParagraph(tree);
  };
}
