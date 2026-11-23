#!/usr/bin/env node
/**
 * A cron result reaches the conversation once, not once per delivery target.
 *
 * A scheduled run's reply is sent to every channel that receives it (private chat, a group,
 * an approval bot). When the run is committed to its session transcript, the gateway mirrors
 * each payload and joins the mirrored texts with newlines, so one report shows up two to six
 * times: once per channel. The mirror only needs one copy of a reply with identical text.
 * Real delivery is untouched, and each payload's media still travels separately.
 *
 * Usage: node scripts/patch-openclaw-cron-results.mjs [--runtime /absolute/path/to/openclaw]
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--runtime"))
  throw new Error("Usage: script [--runtime /absolute/path/to/openclaw]");
const require = createRequire(new URL("../packages/adapters/package.json", import.meta.url));
const runtime = args.length
  ? resolve(args[1])
  : resolve(dirname(require.resolve("openclaw/plugin-sdk/gateway-runtime")), "../..");
const dist = join(runtime, "dist");

const target = `\t\ttext: e.map(({ payload: e }) => resolveOutboundPayloadMirrorText(e)).filter((e) => Boolean(e)).join("\\n"),`;
const patched = `\t\ttext: [...new Set(e.map(({ payload: e }) => resolveOutboundPayloadMirrorText(e)).filter((e) => Boolean(e)))].join("\\n"),`;

const names = (await readdir(dist)).filter((name) => /^payloads-.*\.mjs$/.test(name));
const matches = [];
for (const name of names) {
  const body = await readFile(join(dist, name), "utf8");
  if (body.includes(patched)) {
    console.log(`Already patched: ${join(dist, name)}`);
    process.exit(0);
  }
  if (body.includes(target)) matches.push(name);
}
if (matches.length !== 1) throw new Error(`Expected one outbound payload module; found ${matches.length}`);

const file = join(dist, matches[0]);
const before = await readFile(file, "utf8");
const after = before.replace(target, patched);
const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
  input: after,
  encoding: "utf8",
});
if (check.status !== 0) throw new Error(check.stderr || "Syntax check failed; nothing changed");

const backups = join(homedir(), ".openclaw/backups");
await mkdir(backups, { recursive: true, mode: 0o700 });
const backup = join(backups, `cron-results-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.mjs`);
await copyFile(file, backup);
try {
  await writeFile(file, after);
  if ((await readFile(file, "utf8")) !== after) throw new Error("Runtime write verification failed");
} catch (error) {
  await copyFile(backup, file);
  throw error;
}
console.log(`Patched: ${file}\nBackup: ${backup}`);
