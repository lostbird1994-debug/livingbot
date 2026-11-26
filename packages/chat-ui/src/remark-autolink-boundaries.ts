type Point = { offset?: number; line?: number; column?: number };
type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: Point; end: Point };
};

// In bare URLs these separate surrounding prose. Explicit Markdown links and
// angle autolinks remain authoritative, including URLs containing these characters.
const prosePunctuation = /[，。；：！？、…“”‘’（）【】《》「」『』]/u;

/**
 * GFM can consume closing emphasis and adjacent Chinese prose as an autolink.
 * Repair only parser-identified bare links, then let the same parser recover
 * emphasis. Code, explicit destinations and all remaining GFM features stay intact.
 */
export function remarkAutolinkBoundaries(this: { parse(source: string): unknown }) {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    if (typeof file.value !== "string") return;
    const source = file.value;
    const edits: Array<{ start: number; end: number }> = [];
    const walk = (node: MarkdownNode) => {
      if (node.type === "link") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const raw = source.slice(start, end);
        if (!/^https?:\/\//i.test(raw)) return;
        let length = raw.search(prosePunctuation);
        if (length < 0) length = raw.length;
        const marker = source
          .slice(Math.max(0, start - 3), start)
          .match(/(\*{1,3}|_{1,3}|~~)$/)?.[1];
        if (marker) {
          const closing = raw.indexOf(marker);
          if (closing >= 0) length = Math.min(length, closing);
        }
        if (length > 0 && length < raw.length) edits.push({ start, end: start + length });
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    if (!edits.length) return;
    let repaired = source;
    // Offsets belong to the original input; apply the last edit first.
    for (const { start, end } of edits.sort((left, right) => right.start - left.start)) {
      repaired = `${repaired.slice(0, start)}<${repaired.slice(start, end)}>${repaired.slice(end)}`;
    }
    const parsed = this.parse(repaired) as MarkdownNode;
    const insertions = edits.flatMap(({ start, end }) => [start, end]).sort((a, b) => a - b);
    const restorePoint = (point: Point) => {
      if (point.offset === undefined) return;
      const parsedOffset = point.offset;
      const added = insertions.filter((offset, index) => offset + index < parsedOffset).length;
      point.offset = parsedOffset - added;
      point.column =
        point.offset === 0 ? 1 : point.offset - source.lastIndexOf("\n", point.offset - 1);
    };
    const restorePositions = (node: MarkdownNode) => {
      if (node.position) {
        restorePoint(node.position.start);
        restorePoint(node.position.end);
      }
      for (const child of node.children ?? []) restorePositions(child);
    };
    restorePositions(parsed);
    Object.assign(tree, parsed);
  };
}
