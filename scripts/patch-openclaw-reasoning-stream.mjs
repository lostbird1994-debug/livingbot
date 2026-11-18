#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Lets OpenClaw stream the model's reasoning to the client.
 *
 * The agent RPC entry calls runEmbeddedPiAgent with `thinkLevel` but without `reasoningLevel`
 * or `onReasoningStream`. The session subscriber only emits `{stream:"thinking"}` frames when
 * `reasoningMode === "stream" && thinkingLevel !== "off" && typeof onReasoningStream === "function"`,
 * so these must follow the session's explicit reasoning visibility setting.
 *
 * The frame itself is emitted by the session subscriber through the run's agent event sink, which
 * is already wired (`onAgentEvent`), so the callback passed here only has to exist.
 *
 * Re-run after upgrading the runtime. Idempotent, backs the file up, and rolls back if the result
 * does not parse.
 *
 * Usage: node scripts/patch-openclaw-reasoning-stream.mjs
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { patchReasoningStream } from "./openclaw-reasoning-patches.mjs";

const FILE = /^attempt-execution-.*\.js$/;
const MARKER = "reasoningLevel: params.sessionEntry?.reasoningLevel";
const ANCHOR = "\t\tfastMode: params.fastMode,\n";

async function runtimeDir() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--runtime"))
    throw new Error("Usage: script [--runtime /absolute/path/to/openclaw]");
  const require = createRequire(new URL("../packages/adapters/package.json", import.meta.url));
  return args.length
    ? resolve(args[1])
    : resolve(dirname(require.resolve("openclaw/plugin-sdk/gateway-runtime")), "../..");
}

const runtime = await runtimeDir();
if (!runtime || !existsSync(runtime)) {
  console.error(`No OpenClaw runtime found${runtime ? ` at ${runtime}` : ""}.`);
  process.exit(1);
}
const dist = join(runtime, "dist");
const matches = (await readdir(dist)).filter((entry) => FILE.test(entry));
const name = matches.length === 1 ? matches[0] : undefined;
if (!name) {
  console.error(`No agent entry point in ${dist}; is this an OpenClaw runtime?`);
  process.exit(1);
}
const file = join(dist, name);
const source = await readFile(file, "utf8");
if (source.includes(MARKER)) {
  console.log(`Already patched: ${file}`);
  process.exit(0);
}
if (!source.includes(ANCHOR)) {
  console.error(
    `The agent entry point does not look like this release expects; nothing changed.\n  ${file}`,
  );
  process.exit(1);
}
const patched = patchReasoningStream(source);
const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
  input: patched,
  encoding: "utf8",
});
if (check.status !== 0)
  throw new Error(check.stderr || "Syntax verification failed; nothing changed");

const backup = join(
  homedir(),
  ".openclaw/backups",
  `reasoning-stream-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.js`,
);
await mkdir(join(homedir(), ".openclaw/backups"), { recursive: true, mode: 0o700 });
await copyFile(file, backup);
try {
  await writeFile(file, patched);
  if ((await readFile(file, "utf8")) !== patched) throw new Error("Write verification failed");
} catch (error) {
  await copyFile(backup, file);
  throw error;
}

console.log(`Patched ${file}
  backup: ${backup}

Restart the engine gateway so new runs stream reasoning:
  openclaw gateway restart`);
