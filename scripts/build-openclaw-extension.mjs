#!/usr/bin/env node
/**
 * Build and install the OpenClaw collaboration extension.
 *
 * The extension is two halves that must ship together:
 *   - index.js              (bundled from packages/adapters/src/native-collaboration-openclaw.ts)
 *   - openclaw.plugin.json  (declares contracts.tools: the engine refuses the whole
 *                            registration if any registered tool name is undeclared)
 *
 * On 2026-11-13 the manifest lived only in ~/.openclaw/extensions and was missing three
 * names, so the engine silently dropped all 36 host tools; branch tasks then had no tools
 * at all. Keeping the manifest in the repo and installing it with the bundle is what stops
 * that from coming back.
 *
 * Usage:
 *   node scripts/build-openclaw-extension.mjs
 *   OPENCLAW_EXTENSIONS_DIR=/tmp/ext node scripts/build-openclaw-extension.mjs
 */
import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repo, "packages/adapters/extension");
const target = process.env.OPENCLAW_EXTENSIONS_DIR
  ? join(process.env.OPENCLAW_EXTENSIONS_DIR, "rakazo-collaboration")
  : join(homedir(), ".openclaw/extensions/rakazo-collaboration");
const staging = join(target, "index.staging.js");

await mkdir(target, { recursive: true });
await build({
  entryPoints: [join(repo, "packages/adapters/src/native-collaboration-openclaw.ts")],
  outfile: staging,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "warning",
});

// Declaring the tools is what the engine checks; verify against the names the bundle
// actually registers, before anything is installed.
const manifest = JSON.parse(await readFile(join(source, "openclaw.plugin.json"), "utf8"));
const declared = new Set(manifest.contracts?.tools ?? []);
if (!declared.size) throw new Error("openclaw.plugin.json declares no contracts.tools");
const { nativeHostToolNames } = await import(pathToFileURL(staging).href);
const missing = nativeHostToolNames.filter((name) => !declared.has(name));
if (missing.length) {
  // Preserve the failed staging bundle for diagnosis; never permanently delete it here.
  throw new Error(
    `openclaw.plugin.json must declare these registered tools: ${missing.join(", ")}`,
  );
}

await rename(staging, join(target, "index.js"));
await copyFile(join(source, "openclaw.plugin.json"), join(target, "openclaw.plugin.json"));
await copyFile(join(source, "package.json"), join(target, "package.json"));
console.log(
  `installed ${target}\n  tools declared: ${manifest.contracts.tools.length}` +
    ` (registered: ${nativeHostToolNames.length})`,
);
