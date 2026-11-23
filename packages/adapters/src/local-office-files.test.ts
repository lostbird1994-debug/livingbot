import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { LocalOfficeFiles } from "./local-office-files.mjs";

test("editor inputs are copies and exports cannot overwrite or escape workspace outputs", async () => {
  const root = await mkdtemp(resolve("local/test-fixtures/office-files-"));
  const workspace = join(root, "workspace"), state = join(root, "state");
  await mkdir(join(workspace, "tasks"), { recursive: true }); await mkdir(state);
  const source = join(workspace, "tasks/source.txt"); await writeFile(source, "original");
  const files = new LocalOfficeFiles(workspace, state), copy = await files.input(source);
  await writeFile(copy, "edited"); assert.equal(await readFile(source, "utf8"), "original");
  await assert.rejects(files.output(source), /already exists/);
  await assert.rejects(files.output(join(workspace, "profile/out.txt")), /tasks/);
  await symlink(state, join(workspace, "tasks/escape"));
  await assert.rejects(files.output(join(workspace, "tasks/escape/out.txt")), /escapes/);
  const output = await files.output(join(workspace, "tasks/result.txt"));
  await writeFile(output.staged, "delivered"); await files.publish(output.staged, output.target);
  assert.equal(await readFile(output.target, "utf8"), "delivered");
  await assert.rejects(files.publish(output.staged, output.target), { code: "EEXIST" });
  files.own(copy); files.assertEditor(copy); assert.throws(() => files.assertEditor(source), /Open this file/);
});
