import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readNativeWorkspaceBytes } from "./openclaw-workspace-attachments.js";

it("reads relative and absolute binary outputs from the registered agent workspace", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "kernel-attachment-test-")));
  await mkdir(path.join(root, "outputs"));
  const bytes = Buffer.from([0, 255, 16, 0, 128]);
  const name = path.join(root, "outputs", "result.bin");
  await writeFile(name, bytes);
  expect(await readNativeWorkspaceBytes(root, "outputs/result.bin", bytes.length)).toEqual(new Uint8Array(bytes));
  expect(await readNativeWorkspaceBytes(root, name, bytes.length)).toEqual(new Uint8Array(bytes));
  await expect(readNativeWorkspaceBytes(root, name, bytes.length - 1)).rejects.toThrow("too large");
});

it("refuses other workspaces, links and directories rather than falling back to the old computer home", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "kernel-attachment-boundary-")));
  const root = path.join(base, "agent");
  const outside = path.join(base, "other");
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, "private.txt"), "another bot's file");
  await symlink(path.join(outside, "private.txt"), path.join(root, "linked.txt"));
  await link(path.join(outside, "private.txt"), path.join(root, "hardlinked.txt"));
  await symlink(outside, path.join(root, "linked-directory"));
  for (const name of [
    path.join(outside, "private.txt"), "../other/private.txt", "linked.txt",
    "hardlinked.txt", "linked-directory/private.txt", ".",
  ]) await expect(readNativeWorkspaceBytes(root, name, 1024)).rejects.toThrow();
});
