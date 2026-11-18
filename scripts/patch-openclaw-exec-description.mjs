#!/usr/bin/env node
/**
 * Adds a required `description` to OpenClaw's exec tool.
 *
 * The engine's exec schema only carries the command, so a chat can show which program ran but not
 * what it was for. Our own shell tool can be told what to write; this one cannot, because the
 * schema belongs to the installed runtime. WorkBuddy's shell tool solves this with a required
 * `description` argument that the chat renders instead of the command, so this patch gives exec the
 * same argument and asks for it in the tool's own description.
 *
 * Like WorkBuddy, the requirement is declared rather than enforced at runtime: a model that skips
 * the field still runs its command, and the chat then falls back to naming what the command does.
 * The declaration is what makes a compliant model fill it in every time.
 *
 * This script supports the pinned macOS installation layout below. It is a local patch,
 * not a dependency change: re-run it after upgrading the runtime. It is
 * idempotent, backs each file up first, and refuses to guess when the expected code is not there.
 *
 * Usage: node scripts/patch-openclaw-exec-description.mjs
 */
import { existsSync } from "node:fs";
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PATCHES = [
  {
    file: /^bash-tools\.schemas-.*\.js$/,
    what: "exec schema",
    marker: "What this command accomplishes",
    anchor: '\tcommand: Type.String({ description: "Shell command to execute" }),\n',
    replace: undefined,
    insert:
      '\tdescription: Type.String({ description: "What this command accomplishes, in 5-12 words, in the user\'s language, active voice. The user reads this instead of the command, so say what it is for, never how risky it is." }),\n',
  },
  {
    file: /^bash-tools\.descriptions-.*\.js$/,
    what: "exec tool description",
    marker: "Always pass `description`",
    anchor: '\t\t"Use pty=true for TTY-required commands (terminal UIs, coding agents)."\n',
    // The anchor is the array's last element, so the new sentence takes the comma, not the anchor.
    replace:
      '\t\t"Use pty=true for TTY-required commands (terminal UIs, coding agents).",\n' +
      '\t\t"Always pass `description`: 5-12 words in the user\'s language, active voice, saying what the command is for. The chat shows that line instead of the command, so it is required on every call.",\n',
  },
];

/** The newest pinned runtime. */
async function runtimeDir() {
  const root = join(homedir(), "Library/Application Support/Collection");
  if (!existsSync(root)) return undefined;
  const candidates = (await readdir(root))
    .filter((name) => name.startsWith("OpenClaw-runtime-"))
    .sort()
    .reverse();
  return candidates[0] ? join(root, candidates[0], "lib/node_modules/openclaw") : undefined;
}

/** A patch that breaks the module would break every run, so parse it before keeping it. */
async function loads(source) {
  const { spawnSync } = await import("node:child_process");
  const probe = join(homedir(), ".openclaw/backups", ".patch-probe.mjs");
  await writeFile(probe, source);
  const result = spawnSync(process.execPath, ["--check", probe], { encoding: "utf8" });
  if (result.status !== 0) console.error(result.stderr.trim());
  return result.status === 0;
}

async function fileFor(runtime, pattern) {
  const dir = join(runtime, "dist");
  const name = (await readdir(dir)).find((entry) => pattern.test(entry));
  return name ? join(dir, name) : undefined;
}

const runtime = await runtimeDir();
if (!runtime || !existsSync(runtime)) {
  console.error(`No OpenClaw runtime found${runtime ? ` at ${runtime}` : ""}.`);
  process.exit(1);
}

let failures = 0;
for (const patch of PATCHES) {
  const file = await fileFor(runtime, patch.file);
  if (!file) {
    console.error(`No file for the ${patch.what} in ${runtime}/dist.`);
    failures += 1;
    continue;
  }
  const source = await readFile(file, "utf8");
  if (source.includes(patch.marker)) {
    console.log(`Already patched (${patch.what}): ${file}`);
    continue;
  }
  if (!source.includes(patch.anchor)) {
    console.error(
      `${patch.what} does not look like this release expects; nothing changed.\n  ${file}`,
    );
    failures += 1;
    continue;
  }
  const backup = join(
    homedir(),
    ".openclaw/backups",
    `${patch.what.replaceAll(/\s+/g, "-")}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.js`,
  );
  await copyFile(file, backup);
  const replacement = patch.replace ?? patch.anchor + patch.insert;
  await writeFile(file, source.replace(patch.anchor, replacement));
  const patched = await readFile(file, "utf8");
  if (patched.split(patch.marker).length !== 2 || !(await loads(patched))) {
    await copyFile(backup, file);
    console.error(`${patch.what} verification failed; restored ${file}`);
    failures += 1;
    continue;
  }
  console.log(`Patched (${patch.what}): ${file}\n  backup: ${backup}`);
}

if (failures) {
  console.error(`\n${failures} patch(es) could not be applied.`);
  process.exit(1);
}
console.log(`
Restart the engine gateway so new runs see this:
  openclaw gateway restart`);
