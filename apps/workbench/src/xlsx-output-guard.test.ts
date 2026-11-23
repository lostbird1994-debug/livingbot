import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/**
 * A produced workbook must never replace the source or any existing file. These
 * checks run the real script and its exclusive-write helper offline: no kernel,
 * no model, and no workbook library needed, because the output is refused before
 * the library loads.
 */
const run = promisify(execFile);
const scripts = fileURLToPath(new URL(
  "../../../packages/kernel-runtime/native-plugin/skills/livingbot-tables/scripts/", import.meta.url));
const cli = join(scripts, "xlsx-workbook.mjs");
const helper = pathToFileURL(join(scripts, "exclusive-output.mjs")).href;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function workspace() {
  return mkdtemp(join(tmpdir(), "livingbot-xlsx-guard-"));
}

async function attempt(args: string[]) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function callHelper(target: string, content: string) {
  const program = `import { writeNewFile } from ${JSON.stringify(helper)};
await writeNewFile(process.argv[1], Buffer.from(process.argv[2], "utf8"));`;
  try {
    await run(process.execPath, ["--input-type=module", "-e", program, target, content]);
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
}

test("a new output path receives the workbook bytes", async () => {
  const root = await workspace();
  const target = join(root, "结果.xlsx");
  const result = await callHelper(target, "workbook-bytes");
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readFile(target, "utf8")), "workbook-bytes");
});

test("an existing destination is refused and keeps its own bytes", async () => {
  const root = await workspace();
  const target = join(root, "已存在.xlsx");
  await writeFile(target, "someone else's workbook");
  const result = await callHelper(target, "new bytes");
  assert.notEqual(result.code, 0, "the second write must fail");
  assert.match(result.stderr, /output-exists|输出路径已存在/);
  assert.equal((await readFile(target, "utf8")), "someone else's workbook");
});

test("an output equal to the source is refused and the source keeps its digest", async () => {
  const root = await workspace();
  const source = join(root, "源.xlsx");
  const original = Buffer.from("source workbook bytes");
  await writeFile(source, original);
  const result = await attempt(["--input", source, "--output", source, "--ops", join(root, "ops.json")]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /"code":"output-is-source"/);
  assert.equal(digest(await readFile(source)), digest(original), "the source is byte-identical");
});

test("a link or hardlink to the source is refused instead of being followed", async () => {
  const root = await workspace();
  const source = join(root, "源.xlsx");
  const original = Buffer.from("source workbook bytes");
  await writeFile(source, original);
  const symbolic = join(root, "别名-link.xlsx");
  const hard = join(root, "别名-hard.xlsx");
  await symlink(source, symbolic);
  await link(source, hard);
  for (const alias of [symbolic, hard]) {
    const result = await attempt(["--input", source, "--output", alias, "--ops", join(root, "ops.json")]);
    assert.equal(result.code, 1, `${alias} must be refused`);
    assert.match(result.stdout, /"code":"output-(is-source|exists)"/);
    assert.equal(digest(await readFile(source)), digest(original), "the source is byte-identical through a link");
  }
});

test("an existing destination other than the source is refused before any bytes change", async () => {
  const root = await workspace();
  const source = join(root, "源.xlsx");
  const destination = join(root, "已有结果.xlsx");
  const original = Buffer.from("source workbook bytes");
  const existing = Buffer.from("an earlier deliverable");
  await writeFile(source, original);
  await writeFile(destination, existing);
  const result = await attempt(["--input", source, "--output", destination, "--ops", join(root, "ops.json")]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /"code":"output-exists"/);
  assert.equal(digest(await readFile(destination)), digest(existing), "the existing file is untouched");
  assert.equal(digest(await readFile(source)), digest(original), "the source is untouched");
});

test("a fresh output path is not refused for being an overwrite", async () => {
  const root = await workspace();
  const source = join(root, "源.xlsx");
  const destination = join(root, "新结果.xlsx");
  await writeFile(source, Buffer.from("source workbook bytes"));
  const result = await attempt(["--input", source, "--output", destination, "--ops", join(root, "ops.json")]);
  assert.doesNotMatch(result.stdout, /"code":"output-(is-source|exists)"/,
    "a new name must reach the workbook step rather than being refused");
  await assert.rejects(readFile(destination), "nothing is written when the workbook step cannot finish");
});
