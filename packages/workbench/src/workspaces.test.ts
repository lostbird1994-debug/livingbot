import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Workspaces } from "./workspaces.ts";

async function fixture() {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp("local/test-fixtures/workspaces-");
  return { root, workspaces: new Workspaces(join(process.cwd(), root, "bots")) };
}

test("files land in the selected area and are never silently overwritten", async () => {
  const { workspaces } = await fixture();
  const path = await workspaces.write("example", "tasks", "task-1/result.txt", "first");
  assert.equal(await readFile(path, "utf8"), "first");
  await assert.rejects(workspaces.write("example", "tasks", "task-1/result.txt", "second"), /EEXIST/);
  assert.equal(await readFile(path, "utf8"), "first");
  await assert.rejects(workspaces.write("example", "tasks", "../../outside.txt", "bad"), /escapes/);
});

test("symlink parents and workspace areas cannot redirect writes", async () => {
  const { root, workspaces } = await fixture();
  const base = await workspaces.prepare("example");
  const outside = join(process.cwd(), root, "outside");
  await mkdir(outside);
  await symlink(outside, join(base, "tasks", "link"));
  await assert.rejects(workspaces.write("example", "tasks", "link/secret.txt", "bad"), /directory|outside/);
});

test("workspace browsing is directory-scoped, hides links and opens only regular in-workspace files", async () => {
  const { workspaces } = await fixture();
  const base = await workspaces.initialize("example");
  await workspaces.write("example", "projects", "demo/result.txt", "result");
  await symlink(join(base, "projects", "demo", "result.txt"), join(base, "projects", "demo", "linked.txt"));
  await writeFile(join(base, ".private-state"), "hidden");
  const root = await workspaces.listDirectory("example");
  assert.ok(root.some((entry) => entry.path === "projects" && entry.kind === "dir"));
  assert.ok(root.some((entry) => entry.path === "AGENTS.md" && entry.kind === "file"));
  assert.ok(!root.some((entry) => entry.path === ".private-state"));
  assert.deepEqual(await workspaces.listDirectory("example", "projects/demo"), [
    { path: "projects/demo/result.txt", kind: "file", size: 6 },
  ]);
  assert.equal(await readFile(await workspaces.workspaceFile("example", "AGENTS.md"), "utf8"), await readFile(join(base, "AGENTS.md"), "utf8"));
  await assert.rejects(workspaces.workspaceFile("example", "projects/demo/linked.txt"), /symbolic link/);
  await assert.rejects(workspaces.listDirectory("example", "../outside"), /Invalid workspace directory/);
});

test("artifact delivery records integrity, ownership and a unique immutable path", async () => {
  const { workspaces } = await fixture();
  const artifact = await workspaces.artifact({
    agentId: "example", botId: "example-id", conversationId: "conversation-1",
    taskId: "task-1", name: "result.txt", content: new TextEncoder().encode("result"),
    mediaType: "text/plain",
  });
  assert.equal(artifact.bytes, 6);
  assert.equal(artifact.digest.length, 64);
  assert.equal(artifact.botId, "example-id");
  assert.equal(await readFile(artifact.path, "utf8"), "result");
});

test("a Bot workspace cannot alias another Bot even within the managed root", async () => {
  const { workspaces } = await fixture();
  const other = await workspaces.prepare("other");
  await symlink(other, join(workspaces.root, "alias"));
  await assert.rejects(workspaces.write("alias", "memory", "private.txt", "bad"), /symbolic link/);
  const unexpectedArea = join(workspaces.root, "new-bot");
  await mkdir(unexpectedArea);
  await symlink(join(other, "memory"), join(unexpectedArea, "memory"));
  await assert.rejects(workspaces.prepare("new-bot"), /symbolic link/);
});

test("new workspaces receive directory and delivery rules without replacing existing Bot instructions", async () => {
  const { workspaces } = await fixture();
  const base = await workspaces.initialize("example");
  const instructions = await readFile(join(base, "AGENTS.md"), "utf8");
  assert.ok(instructions.includes("tasks/<task>/"));
  assert.ok(instructions.includes("livingbot_deliver_file"));
  await writeFile(join(base, "AGENTS.md"), "Existing synthetic Bot instructions");
  await workspaces.initialize("example");
  assert.equal(await readFile(join(base, "AGENTS.md"), "utf8"), "Existing synthetic Bot instructions");
});
