import { NativePreviewFrame as PreviewFrame } from "@livingbot/ui-web/native-preview";
export { PreviewFrame };
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Download, Eye, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { codeExport } from "./code-export.ts";
import { columnWidths, nextDirection, sortedOrder, tableCsv, tableTsv } from "./table-data.ts";
import type { SortDirection } from "./table-data.ts";

let measureCanvas: HTMLCanvasElement | undefined;

/** Text width at the table's own font, so columns match what is actually drawn. */
function textWidth(text: string, font: string): number {
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) return text.length * 7;
  context.font = font;
  return context.measureText(text).width;
}

export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}

function Table({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<{ column: number; direction: SortDirection }>();
  const frame = useRef<HTMLDivElement>(null);
  /**
   * Measure the real text and pin each column, so a re-render or a window resize
   * does not shuffle the layout of a wide table. The total is capped by
   * `columnWidths`; below that the table keeps the container width.
   */
  const measure = () => {
    const table = frame.current?.querySelector("table");
    const scroller = frame.current?.querySelector<HTMLElement>(".table-scroll");
    if (!table || !scroller || table.rows.length === 0) return;
    const sample = table.rows[0]?.cells[0];
    const style = sample ? getComputedStyle(sample) : undefined;
    const font = style ? `${style.fontWeight} ${style.fontSize} ${style.fontFamily}` : "12px system-ui";
    const columns = table.rows[0]?.cells.length ?? 0;
    const widths = new Array<number>(columns).fill(0);
    for (const row of [...table.rows]) {
      for (const [index, cell] of [...row.cells].entries()) {
        widths[index] = Math.max(widths[index] ?? 0, textWidth(cell.innerText.trim(), font));
      }
    }
    const sizes = columnWidths(widths);
    if (!sizes.length) return;
    const total = sizes.reduce((sum, width) => sum + width, 0);
    table.style.tableLayout = "fixed";
    const head = table.rows[0];
    if (head) [...head.cells].forEach((cell, index) => { cell.style.width = `${sizes[index]}px`; });
    table.style.width = `${Math.max(total, scroller.clientWidth)}px`;
  };
  // Streaming and sorting both change the text; measure once per frame.
  useEffect(() => {
    const handle = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(handle);
  });
  useEffect(() => {
    // Web fonts settle after first paint; measure again once they are ready.
    void document.fonts?.ready.then(() => measure());
  }, []);
  const rowsOf = () => {
    const table = frame.current?.querySelector("table");
    return table ? [...table.rows].map((row) => [...row.cells].map((cell) => cell.innerText)) : [];
  };
  // Sorting reorders the rendered rows, so a viewer can read a wide table without exporting it.
  const applySort = (column: number) => {
    const table = frame.current?.querySelector("table");
    const body = table?.tBodies[0];
    if (!table || !body || body.rows.length < 2) return;
    const direction = nextDirection(sort?.direction, column, sort?.column);
    // Reorder the existing rows; rewriting text would drop links, emphasis and code.
    const rows = [...body.rows];
    for (const index of sortedOrder(rowsOf(), column, direction)) {
      const row = rows[index];
      if (row) body.appendChild(row);
    }
    setSort({ column, direction });
  };
  return <div className={`table-frame${expanded ? " table-expanded" : ""}`} ref={frame}>
    <div className="table-actions">
      <Button variant="ghost" size="icon-sm" aria-label={expanded ? "收起表格" : "放大表格"} aria-pressed={expanded}
        onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>
      <Button variant="ghost" size="icon-sm" aria-label="复制表格" onClick={async (event) => {
        const table = event.currentTarget.closest(".table-frame")?.querySelector("table");
        if (!table) return;
        const text = tableTsv([...table.rows].map((row) => [...row.cells].map((cell) => cell.innerText)));
        await navigator.clipboard.writeText(text); setCopied(true);
      }}>{copied ? <Check /> : <Copy />}</Button>
      <Button variant="ghost" size="icon-sm" aria-label="导出表格" onClick={(event) => {
        const table = event.currentTarget.closest(".table-frame")?.querySelector("table");
        if (!table) return;
        const csv = tableCsv([...table.rows].map((row) => [...row.cells].map((cell) => cell.innerText)));
        download("table.csv", `\ufeff${csv}`, "text/csv;charset=utf-8");
      }}><Download /></Button>
    </div>
    <div className="table-scroll"><table onClick={(event) => {
      const cell = (event.target as HTMLElement).closest("th");
      if (!cell) return;
      const column = [...(cell.parentElement?.children ?? [])].indexOf(cell);
      if (column >= 0) applySort(column);
    }} data-sorted-column={sort?.column} data-sorted-direction={sort?.direction}>{children}</table></div>
  </div>;
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const language = className?.replace("language-", "") ?? "";
  const source = String(children ?? "").replace(/\n$/, "");
  const exported = codeExport(language);
  if (!className && !source.includes("\n")) return <code>{children}</code>;
  return <span className="code-block">
    <span className="code-actions"><span>{language || "代码"}</span>
      <Button variant="ghost" size="icon-sm" aria-label="复制代码" onClick={async () => {
        await navigator.clipboard.writeText(source); setCopied(true);
      }}>{copied ? <Check /> : <Copy />}</Button>
      <Button variant="ghost" size="icon-sm" aria-label="导出代码" onClick={() => download(exported.name, source, exported.mediaType)}><Download /></Button>
      {exported.preview && <Button variant="ghost" size="sm" aria-pressed={preview} onClick={() => setPreview(!preview)}><Eye />预览</Button>}
    </span>
    {preview ? <PreviewFrame source={source} /> : <code className={className}>{source}</code>}
  </span>;
}

export function Content({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={{
    table: ({ children }) => <Table>{children}</Table>,
    code: ({ className, children }) => <Code className={className}>{children}</Code>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    img: ({ alt }) => <span className="text-muted-foreground">[图片：{alt}]</span>,
  }}>{text}</Markdown>;
}

