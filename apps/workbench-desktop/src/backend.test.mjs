import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("a parent disconnect during failed startup never raises an unhandled IPC error", async () => {
  const root = await mkdtemp(resolve("local/test-fixtures/backend-disconnect-"));
  const child = fork(fileURLToPath(new URL("./backend.mjs", import.meta.url)),
    [root, resolve(root, "missing-kernel.mjs"), resolve(root, "web")], { silent: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code));
  });
  child.disconnect();
  assert.equal(await exited, 1);
  assert.ok(!stderr.includes("ERR_IPC_CHANNEL_CLOSED"), stderr);
  assert.ok(!stderr.includes("ERR_IPC_DISCONNECTED"), stderr);
});
