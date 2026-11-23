#!/usr/bin/env node
/**
 * A cron result reaches the conversation once, not once per delivery target.
 *
 * The gateway commits a scheduled run's visible reply to its session transcript by mirroring
 * every outbound payload. One reply fans out to each channel that receives it (private chat,
 * a group, an approval bot), so the same text appears several times, and the conversation
 * shows the whole report two to six times over. Delivery itself is unchanged: the mirror only
 * needs one copy of a reply with identical text and media.
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
const names = (await readdir(dist)).filter((name) => /^background-result-payloads-.*\.mjs$/.test(name));
if (names.length !== 1) throw new Error("Expected one background result module; nothing changed");
const file = join(dist, names[0]);

const target = "\tconst t = e.payloads.map(toTranscriptPayload);";
const replacement = `\tconst t = (() => { const seen = new Set(); return e.payloads.map(toTranscriptPayload).filter((payload) => { const key = JSON.stringify([payload.text ?? "", payload.mediaUrl ?? "", payload.mediaUrls ?? [], payload.attachments ?? []]); if (seen.has(key)) return false; seen.add(key); return true; }); })();`;

const before = await readFile(file, "utf8");
if (!before.includes(target)) {
  if (before.includes("const seen = new Set(); return e.payloads.map(toTranscriptPayload)")) {
    console.log(`Already patched: ${file}`);
    process.exit(0);
  }
  throw new Error("Background result module changed shape; nothing changed");
}
const after = before.replace(target, replacement);
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
