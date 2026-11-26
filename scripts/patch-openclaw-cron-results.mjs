#!/usr/bin/env node
/**
 * Replay each cron occurrence once, preserving report text verbatim.
 * Remove older text-based fallbacks when upgrading an existing installation.
 *
 * Usage: node scripts/patch-openclaw-cron-results.mjs [--runtime /absolute/path/to/openclaw]
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  restoreCronPayloadMirror,
  restoreCronResultCommit,
  patchCronResultReplay,
} from "./openclaw-cron-result-patches.mjs";

export async function applyCronResultPatches(runtime, backupRoot = join(homedir(), ".openclaw/backups")) {
  const dist = join(runtime, "dist");
  const names = await readdir(dist);
  const plans = [];
  for (const [pattern, marker, patch] of [
    [/^payloads-.*\.mjs$/, "function projectOutboundPayloadPlanForMirror(", restoreCronPayloadMirror],
    [/^background-result-payloads-.*\.mjs$/, "async function commitBackgroundResultToSession(", restoreCronResultCommit],
    [/^replay-history-.*\.mjs$/, "function normalizeAssistantReplayContent(", patchCronResultReplay],
  ]) {
    const matches = [];
    for (const name of names.filter((name) => pattern.test(name))) {
      const file = join(dist, name);
      const before = await readFile(file, "utf8");
      if (before.includes(marker)) matches.push({ file, before });
    }
    if (matches.length !== 1) throw new Error(`Expected one ${marker} module; found ${matches.length}`);
    const { file, before } = matches[0];
    const after = patch(before);
    const check = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: after, encoding: "utf8" });
    if (check.status !== 0) throw new Error(check.stderr || "Syntax check failed; nothing changed");
    if (after !== before) plans.push({ file, before, after });
  }
  if (!plans.length) return { changed: [], backups: [] };
  const backups = join(backupRoot, `cron-results-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(backups, { recursive: true, mode: 0o700 });
  for (const plan of plans) {
    plan.backup = join(backups, basename(plan.file));
    await copyFile(plan.file, plan.backup);
    if (await readFile(plan.backup, "utf8") !== plan.before) throw new Error("Runtime backup verification failed; nothing changed");
  }
  for (const plan of plans) {
    if (await readFile(plan.file, "utf8") !== plan.before) throw new Error("Runtime changed during patch preparation");
  }
  const written = [];
  try {
    for (const plan of plans) {
      written.push(plan);
      await writeFile(plan.file, plan.after);
      if ((await readFile(plan.file, "utf8")) !== plan.after) throw new Error("Runtime write verification failed");
    }
  } catch (error) {
    for (const plan of written) await copyFile(plan.backup, plan.file);
    throw error;
  }
  return { changed: plans.map((plan) => plan.file), backups: plans.map((plan) => plan.backup) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--runtime"))
    throw new Error("Usage: script [--runtime /absolute/path/to/openclaw]");
  const require = createRequire(new URL("../packages/kernel-runtime/package.json", import.meta.url));
  const runtime = args.length ? resolve(args[1])
    : resolve(dirname(require.resolve("openclaw/plugin-sdk/gateway-runtime")), "../..");
  console.log(JSON.stringify(await applyCronResultPatches(runtime), null, 2));
}
