#!/usr/bin/env node
/**
 * Real XLSX workbook edit for the livingbot-tables method.
 *
 * Reads one workbook with the ExcelJS package, applies the operations named in a
 * JSON file, and writes a new workbook. Untouched sheets, cells, formulas and
 * number formats stay as the reader gave them; the input file is never written,
 * and an output path that already exists (including a link to the source) is
 * refused instead of replaced.
 *
 *   node xlsx-workbook.mjs --input in.xlsx --output out.xlsx --ops ops.json
 *   node xlsx-workbook.mjs --input in.xlsx --inspect
 *
 * ops.json:
 *   { "changes": [{ "sheet": "明细", "cell": "D2", "value": 12.5 }],
 *     "addSheets": [{ "name": "汇总", "rows": [["区域", "金额合计"], ["华东", 963.96]] }] }
 *
 * Every mode ends with one JSON line on stdout so a caller can check what
 * actually happened instead of trusting an exit code.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathExists, sameFile, writeNewFile } from "./exclusive-output.mjs";

function fail(code, message, detail) {
  process.stdout.write(`${JSON.stringify({ ok: false, code, message, ...detail })}\n`);
  process.exit(code === "workbook-tool-unavailable" ? 2 : 1);
}

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const input = option("input");
if (!input) fail("missing-input", "需要 --input 指定源工作簿");
const output = option("output");
const opsPath = option("ops");
const inspect = args.includes("--inspect");
if (!inspect && (!output || !opsPath)) fail("missing-argument", "编辑需要 --input、--output 与 --ops");

const inputPath = resolve(input);
const outputPath = output === undefined ? undefined : resolve(output);
// The destination is checked before the workbook library loads: a refused
// output must not depend on any package being installed, and must leave every
// existing file exactly as it was.
if (outputPath !== undefined) {
  if (await sameFile(inputPath, outputPath)) {
    fail("output-is-source", "输出路径就是源工作簿；不会覆盖原件，请换一个新的文件名");
  }
  if (await pathExists(outputPath)) {
    fail("output-exists", "输出路径已存在；不会覆盖已有文件，请换一个新的文件名");
  }
}

let ExcelJS;
try {
  ExcelJS = (await import("exceljs")).default;
} catch {
  fail("workbook-tool-unavailable",
    "未安装工作簿读写库 exceljs，无法读取或修改 Excel 工作簿；不要改用 CSV 冒充工作簿。");
}

// A cell keeps its formula only when the writer is given the formula together
// with the cached result the source workbook stored.
function reading(cell) {
  const value = cell.value;
  if (value && typeof value === "object" && "formula" in value) {
    return { formula: value.formula, ...("result" in value ? { result: value.result } : {}) };
  }
  return value;
}

const sourceBytes = await readFile(inputPath);
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(sourceBytes);

function sheetOf(name) {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) fail("unknown-sheet", `工作簿中没有工作表「${name}」`);
  return sheet;
}

if (inspect) {
  const sheets = workbook.worksheets.map((sheet) => {
    const cells = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = reading(cell);
        if (value === null || value === undefined || value === "") return;
        cells.push({ cell: cell.address,
          ...(value && typeof value === "object" && "formula" in value
            ? { formula: value.formula, result: value.result ?? null } : { value }),
          numberFormat: cell.numFmt ?? null });
      });
    });
    return { name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount, cells };
  });
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "inspect", sheets })}\n`);
  process.exit(0);
}

const ops = JSON.parse(await readFile(resolve(opsPath), "utf8"));
const changed = [];
for (const change of ops.changes ?? []) {
  const sheet = sheetOf(change.sheet);
  const cell = sheet.getCell(change.cell);
  // A literal string that starts with = would be stored as text; an explicit
  // formula goes through the formula branch so the workbook can recalculate it.
  const formula = change.formula ?? (typeof change.value === "string" && change.value.startsWith("=")
    ? change.value.slice(1) : undefined);
  cell.value = formula === undefined ? change.value : { formula, result: change.result };
  if (change.numberFormat) cell.numFmt = change.numberFormat;
  changed.push({ sheet: sheet.name, cell: cell.address, formula: formula ?? null, value: formula ? null : change.value });
}
for (const addition of ops.addSheets ?? []) {
  if (workbook.getWorksheet(addition.name)) fail("duplicate-sheet", `工作表「${addition.name}」已存在`);
  const sheet = workbook.addWorksheet(addition.name);
  for (const row of addition.rows ?? []) {
    const entry = sheet.addRow([]);
    row.forEach((cell, index) => {
      const target = entry.getCell(index + 1);
      // A row cell may be a plain value or an explicit formula the workbook owns.
      if (cell && typeof cell === "object" && "formula" in cell) {
        target.value = { formula: cell.formula, ...("result" in cell ? { result: cell.result } : {}) };
      } else target.value = cell;
    });
    entry.commit();
  }
}

const written = Buffer.from(await workbook.xlsx.writeBuffer());
try {
  // Exclusive create: a file that appeared since the check above is refused too.
  await writeNewFile(outputPath, written);
} catch (error) {
  fail(error?.code === "output-exists" ? "output-exists" : "output-write-failed",
    error?.code === "output-exists" ? "输出路径已存在；不会覆盖已有文件，请换一个新的文件名" : String(error?.message ?? error));
}
// The file on disk is the only proof. Reopen it and check every requested change;
// a write that cannot be read back is reported, never claimed as done.
const verify = new ExcelJS.Workbook();
await verify.xlsx.readFile(outputPath);
const sameValue = (actual, expected) => {
  if (actual instanceof Date || expected instanceof Date) {
    const left = actual instanceof Date ? actual.getTime() : Number(actual);
    const right = expected instanceof Date ? expected.getTime() : Number(expected);
    return left === right;
  }
  if (typeof actual === "number" && typeof expected === "number") return Math.abs(actual - expected) < 1e-9;
  if (actual && typeof actual === "object" && expected && typeof expected === "object") {
    try { return JSON.stringify(actual) === JSON.stringify(expected); } catch { return false; }
  }
  return String(actual ?? "") === String(expected ?? "");
};
const mismatches = [];
for (const change of ops.changes ?? []) {
  const sheet = verify.getWorksheet(change.sheet);
  if (!sheet) { mismatches.push({ sheet: change.sheet, cell: change.cell, reason: "missing-sheet" }); continue; }
  const cell = sheet.getCell(change.cell);
  const formula = change.formula ?? (typeof change.value === "string" && change.value.startsWith("=")
    ? change.value.slice(1) : undefined);
  if (formula !== undefined) {
    if ((cell.formula ?? "") !== formula) {
      mismatches.push({ sheet: change.sheet, cell: change.cell, expected: `=${formula}`, actual: cell.formula ?? null });
    }
  } else if (!sameValue(cell.value, change.value)) {
    mismatches.push({ sheet: change.sheet, cell: change.cell, expected: change.value, actual: cell.value ?? null });
  }
}
for (const addition of ops.addSheets ?? []) {
  const sheet = verify.getWorksheet(addition.name);
  if (!sheet) { mismatches.push({ sheet: addition.name, reason: "missing-sheet" }); continue; }
  if (sheet.rowCount < (addition.rows ?? []).length) {
    mismatches.push({ sheet: addition.name, reason: "short-sheet", expectedRows: (addition.rows ?? []).length, actualRows: sheet.rowCount });
  }
}
if (mismatches.length) {
  fail("read-back-mismatch", "文件已写入，但回读与请求不一致；请勿当作已完成", {
    written: true, output: outputPath, mismatches,
  });
}
process.stdout.write(`${JSON.stringify({ ok: true, mode: "edit", verified: true,
  sheets: verify.worksheets.map((sheet) => sheet.name), changed,
  addedSheets: (ops.addSheets ?? []).map((sheet) => sheet.name),
  bytes: written.length })}\n`);
