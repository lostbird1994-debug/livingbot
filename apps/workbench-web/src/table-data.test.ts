import assert from "node:assert/strict";
import test from "node:test";
import { columnWidths, nextDirection, sortRows, sortedOrder, tableCsv, tableTsv } from "./table-data.ts";

const rows = [
  ["Name", "Detail", "Empty"],
  ["A \"quote\"", "first line\r\nsecond line", ""],
  ["with\ttab", "café / 中文", "0"],
];

test("CSV export preserves headers, quotes, embedded line endings, empty cells and Unicode", () => {
  assert.equal(tableCsv(rows), [
    '"Name","Detail","Empty"',
    '"A ""quote""","first line\r\nsecond line",""',
    '"with\ttab","café / 中文","0"',
  ].join("\r\n"));
});

test("clipboard TSV preserves cell boundaries and quotes structural content", () => {
  assert.equal(tableTsv(rows), [
    'Name\tDetail\tEmpty',
    '"A ""quote"""\t"first line\r\nsecond line"\t',
    '"with\ttab"\tcafé / 中文\t0',
  ].join("\n"));
});

test("empty and irregular rows remain structurally intact", () => {
  assert.equal(tableCsv([[], ["a", "b"], [""]]), '\r\n"a","b"\r\n""');
  assert.equal(tableTsv([[], ["a", "b"], [""]]), "\na\tb\n");
});

test("sorting keeps the header, compares numbers numerically and is stable", () => {
  const rows = [["名称", "数量"], ["乙", "10"], ["甲", "9"], ["丙", "10"]];
  const ascending = sortRows(rows, 1, "asc");
  assert.deepEqual(ascending.map((row) => row[0]), ["名称", "甲", "乙", "丙"]);
  const descending = sortRows(rows, 1, "desc");
  assert.deepEqual(descending.map((row) => row[0]), ["名称", "乙", "丙", "甲"]);
  const text = sortRows([["名", "值"], ["b", "x"], ["a", "y"]], 0, "asc");
  assert.deepEqual(text.map((row) => row[0]), ["名", "a", "b"]);
});

test("a header click alternates direction only on the same column", () => {
  assert.equal(nextDirection(undefined, 2), "asc");
  assert.equal(nextDirection("asc", 2, 2), "desc");
  assert.equal(nextDirection("desc", 2, 2), "asc");
  assert.equal(nextDirection("desc", 3, 2), "asc");
});

test("measured widths keep readable columns and stop at the 1120px ceiling", () => {
  // Short text still gets the readable minimum.
  assert.deepEqual(columnWidths([10, 20]), [85, 85]);
  // Padding is added per column.
  assert.deepEqual(columnWidths([100, 200]), [132, 232]);
  // A wide table shrinks proportionally instead of overflowing the ceiling.
  const wide = columnWidths([600, 600, 600, 600]);
  assert.ok(wide.reduce((sum, width) => sum + width, 0) <= 1120);
  assert.ok(wide.every((width) => width >= 85));
  // Too many columns: minimums win, and the table is allowed to scroll.
  const many = columnWidths(Array.from({ length: 20 }, () => 500));
  assert.ok(many.every((width) => width === 85));
  assert.equal(columnWidths([]).length, 0);
});

test("sorted order returns body indices so callers can move rows without rewriting cells", () => {
  const rows = [["名", "值"], ["乙", "10"], ["甲", "9"]];
  assert.deepEqual(sortedOrder(rows, 1, "asc"), [1, 0]);
  assert.deepEqual(sortedOrder(rows, 0, "desc"), [0, 1]);
  // The input is untouched: no cell content is rewritten by ordering.
  assert.deepEqual(rows, [["名", "值"], ["乙", "10"], ["甲", "9"]]);
});
