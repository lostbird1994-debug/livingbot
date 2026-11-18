#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Lets a DeepSeek model think while it is calling tools on an OpenAI-compatible provider.
 *
 * Measured against the provider this bot uses, with tools in the request:
 *   - no reasoning parameters      -> no reasoning_content
 *   - reasoning_effort only        -> no reasoning_content
 *   - thinking:{type:"enabled"} + a concrete effort -> reasoning_content
 * The engine's generic transport sends only `reasoning_effort`, and its DeepSeek switch lives in
 * the deepseek provider plugin, which a custom provider never reaches. This patch adds the switch
 * to the transport only when compat.thinkingFormat explicitly selects the DeepSeek protocol.
 *
 * Re-run after upgrading the runtime. Idempotent, backs the file up, rolls back if the result
 * does not parse.
 *
 * Usage: node scripts/patch-openclaw-deepseek-thinking.mjs
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { patchThinkingTransport } from "./openclaw-reasoning-patches.mjs";

const FILE = /^openai-transport-stream-.*\.js$/;
const MARKER = 'compat.thinkingFormat === "deepseek") params.thinking';
const ANCHOR =
  "\telse if (resolvedCompletionsReasoningEffort && model.reasoning && compat.supportsReasoningEffort && !omitGpt54MiniToolReasoningEffort) params.reasoning_effort = resolvedCompletionsReasoningEffort;\n";

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
  console.error(`No openai transport in ${dist}; is this an OpenClaw runtime?`);
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
    `The transport does not look like this release expects; nothing changed.\n  ${file}`,
  );
  process.exit(1);
}
const patched = patchThinkingTransport(source);
const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
  input: patched,
  encoding: "utf8",
});
if (check.status !== 0)
  throw new Error(check.stderr || "Syntax verification failed; nothing changed");

const backup = join(
  homedir(),
  ".openclaw/backups",
  `deepseek-thinking-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.js`,
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

Restart the engine gateway:
  openclaw gateway restart`);
