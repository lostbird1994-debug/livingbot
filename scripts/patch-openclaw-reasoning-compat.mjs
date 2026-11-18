#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { patchReasoningCompat } from "./openclaw-reasoning-patches.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--runtime"))
  throw new Error("Usage: script [--runtime /absolute/path/to/openclaw]");
const require = createRequire(new URL("../packages/adapters/package.json", import.meta.url));
const runtime = args.length
  ? resolve(args[1])
  : resolve(dirname(require.resolve("openclaw/plugin-sdk/gateway-runtime")), "../..");
const dist = join(runtime, "dist");
const names = (await readdir(dist)).filter((name) => /^provider-model-compat-.*\.js$/.test(name));
if (names.length !== 1) throw new Error("Expected one model compatibility module; nothing changed");
const file = join(dist, names[0]);
const before = await readFile(file, "utf8");
const after = patchReasoningCompat(before);
if (after === before) {
  console.log(`Already patched: ${file}`);
} else {
  const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: after,
    encoding: "utf8",
  });
  if (check.status !== 0) throw new Error(check.stderr || "Syntax check failed; nothing changed");
  const backups = join(homedir(), ".openclaw/backups");
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const backup = join(
    backups,
    `reasoning-compat-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.js`,
  );
  await copyFile(file, backup);
  try {
    await writeFile(file, after);
    if ((await readFile(file, "utf8")) !== after)
      throw new Error("Runtime write verification failed");
  } catch (error) {
    await copyFile(backup, file);
    throw error;
  }
  console.log(
    `Patched ${file}\nBackup: ${backup}\nA gateway restart is required to load this change.`,
  );
}
