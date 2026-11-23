export type TableRows = string[][];

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function tableTsv(rows: TableRows): string {
  return rows.map((row) => row.map((cell) =>
    /[\t\r\n"]/.test(cell) ? quoted(cell) : cell,
  ).join("\t")).join("\n");
}

export function tableCsv(rows: TableRows): string {
  return rows.map((row) => row.map(quoted).join(",")).join("\r\n");
}

export type SortDirection = "asc" | "desc";

/**
 * Sorts by one column, keeping the header row first. Values that both look
 * numeric compare as numbers so 9 sorts before 10; everything else compares as
 * text, and equal keys keep their original order.
 */
/**
 * Returns the body-row order for a column, leaving the rows untouched. Callers
 * reorder DOM nodes with it, so links, emphasis and code inside cells survive.
 */
export function sortedOrder(rows: TableRows, column: number, direction: SortDirection): number[] {
  const body = rows.slice(1);
  const numeric = (value: string) => value.trim() !== "" && Number.isFinite(Number(value.trim().replaceAll(",", "")));
  const number = (value: string) => Number(value.trim().replaceAll(",", ""));
  const allNumeric = body.every((row) => numeric(row[column] ?? ""));
  return body.map((row, index) => ({ row, index })).sort((left, right) => {
    const a = left.row[column] ?? "";
    const b = right.row[column] ?? "";
    const order = allNumeric ? number(a) - number(b) : a.localeCompare(b, "zh-CN", { numeric: true });
    return order === 0 ? left.index - right.index : direction === "asc" ? order : -order;
  }).map((entry) => entry.index);
}

export function sortRows(rows: TableRows, column: number, direction: SortDirection): TableRows {
  if (rows.length < 2) return rows;
  const body = rows.slice(1);
  return [rows[0]!, ...sortedOrder(rows, column, direction).map((index) => body[index]!)];
}

/** The next direction for a header click: first click ascending, then descending, then back. */
export function nextDirection(current: SortDirection | undefined, column: number, active?: number): SortDirection {
  if (active !== column || current === undefined) return "asc";
  return current === "asc" ? "desc" : "asc";
}

/**
 * Measured text widths become column widths. Written against the same budget the
 * original viewer used: readable minimum, padding for cell borders, and a total
 * ceiling of 1120px so a wide table scrolls instead of squeezing every column.
 * When the minimums alone exceed the ceiling the table keeps its minimums and
 * scrolls; text is never truncated to force a fit.
 */
export function columnWidths(measured: number[], options: { min?: number; padding?: number; max?: number } = {}): number[] {
  const min = options.min ?? 85;
  const padding = options.padding ?? 32;
  const max = options.max ?? 1120;
  if (measured.length === 0) return [];
  const intrinsic = measured.map((width) => Math.max(min, Math.ceil(Math.max(0, width)) + padding));
  const total = intrinsic.reduce((sum, width) => sum + width, 0);
  if (total <= max) return intrinsic;
  const scale = max / total;
  return intrinsic.map((width) => Math.max(min, Math.floor(width * scale)));
}
