import { createHash } from "node:crypto";
import { cp, readFile, mkdir, mkdtemp, writeFile, chmod, access, rename, readdir, realpath } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Fresh staging only: repeated packaging never removes or replaces a previous build.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [archive, checksums, kernelModules, nodeBinary = process.execPath, memoryAssets] =
  process.argv.slice(2).map((value) => resolve(value));
if (process.platform !== "darwin" || process.arch !== "arm64" || !archive || !checksums || !kernelModules) {
  throw new Error("Usage on macOS arm64: package.mjs <Electron zip> <official SHASUMS256.txt> <initialized kernel node_modules> [node]");
}
const expected = (await readFile(checksums, "utf8")).split("\n")
  .find((line) => line.trim().endsWith("electron-v45.0.0-darwin-arm64.zip"))?.split(/\s+/)[0];
const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
if (!expected || actual !== expected) throw new Error("Official Electron checksum does not match");
const kernelPackage = JSON.parse(await readFile(join(kernelModules, "openclaw/package.json"), "utf8"));
if (kernelPackage.version !== "2026.11.5") throw new Error("Unexpected kernel version");
for (const marker of [".openclaw-lifecycle-pending", "dist/openclaw-install-guard"]) {
  if (await access(join(kernelModules, "openclaw", marker)).then(() => true, () => false)) {
    throw new Error("Initialize the kernel installation before packaging");
  }
}
await mkdir(join(root, "local/releases"), { recursive: true });
const stage = await mkdtemp(join(root, "local/releases/desktop-"));
execFileSync("/usr/bin/ditto", ["-x", "-k", archive, stage]);
const app = join(stage, "LivingBot 2.app");
await rename(join(stage, "Electron.app"), app);
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
const runtime = join(resources, "runtime");
await mkdir(join(resources, "app"), { recursive: true });
await mkdir(join(resources, "bin"), { recursive: true });
await cp(nodeBinary, join(resources, "bin/node"));
await chmod(join(resources, "bin/node"), 0o755);
await mkdir(runtime, { recursive: true });
await writeFile(join(runtime, "package.json"), '{"type":"module","private":true}\n');
for (const name of ["workbench", "workbench-desktop"]) {
  await cp(join(root, "apps", name, "src"), join(runtime, "apps", name, "src"), {
    recursive: true, filter: (path) => !/\.(test|integration)\.[cm]?[jt]sx?$/.test(path),
  });
}
for (const name of ["kernel-runtime", "workbench"]) {
  await cp(join(root, "packages", name, "src"), join(runtime, "packages", name, "src"), {
    recursive: true, filter: (path) => !/\.test\.ts$/.test(path),
  });
}
// Native model settings reuse the same defaults and header validation as web.
await mkdir(join(runtime, "packages/contracts/src"), { recursive: true });
for (const name of ["model-defaults.ts", "model-headers.ts"]) {
  await cp(join(root, "packages/contracts/src", name), join(runtime, "packages/contracts/src", name));
}
await cp(join(root, "packages/kernel-runtime/native-plugin"), join(runtime, "packages/kernel-runtime/native-plugin"), { recursive: true });
await cp(kernelModules, join(runtime, "node_modules"), { recursive: true, verbatimSymlinks: true });
// The official embedding runtime and model travel with the application so a
// plain installation can answer semantically without any manual step.
if (memoryAssets) {
  // Copy the bytes, never a link: an alias that points at the build machine would
  // both escape the bundle and break strict signature verification.
  await cp(memoryAssets, join(resources, "local-memory"), { recursive: true, dereference: true });
  await access(join(resources, "local-memory/tools/llama.cpp"));
  await access(join(resources, "local-memory/models/llama.cpp"));
}
// No file inside the bundle may resolve outside it.
const escaping = [];
const walkBundle = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(path).catch(() => undefined);
      if (!target || !target.startsWith(resources + sep)) escaping.push(path);
    } else if (entry.isDirectory()) await walkBundle(path);
  }
};
await walkBundle(resources);
if (escaping.length) throw new Error(`Bundle contains ${escaping.length} escaping links, e.g. ${escaping[0]}`);
// The selected product frontend (the upgraded 1.0 shell), not the replacement UI.
await cp(join(root, "apps/web/dist"), join(resources, "web"), { recursive: true,
  filter: (path) => !path.endsWith(".map") });
await cp(join(root, "apps/workbench-desktop/src/main.cjs"), join(resources, "app/main.cjs"));
await cp(join(root, "apps/workbench-desktop/src/preload.cjs"), join(resources, "app/preload.cjs"));
await cp(join(root, "apps/workbench-desktop/src/notifications.cjs"), join(resources, "app/notifications.cjs"));
await cp(join(root, "apps/workbench-desktop/src/system-speech.cjs"), join(resources, "app/system-speech.cjs"));
await writeFile(join(resources, "app/package.json"), JSON.stringify({
  name: "livingbot-2", version: "2.0.0-dev.1", main: "main.cjs", productName: "LivingBot 2",
}));
// The initialized installation is self-contained. Never link to the development worktree.
await access(join(runtime, "node_modules/openclaw/openclaw.mjs"));
const iconset = join(stage, "LivingBot.iconset");
await mkdir(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    execFileSync("/usr/bin/sips", ["-z", String(size * scale), String(size * scale),
      join(root, "apps/desktop/assets/icon-macos.png"), "--out",
      join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "pipe" });
  }
}
execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(resources, "LivingBot.icns")]);
await rename(join(contents, "MacOS/Electron"), join(contents, "MacOS/LivingBot 2"));
for (const [key, value] of Object.entries({
  CFBundleIdentifier: "app.livingbot.v2", CFBundleName: "LivingBot 2",
  CFBundleDisplayName: "LivingBot 2", CFBundleShortVersionString: "2.0.0",
  CFBundleVersion: "2.0.0", CFBundleExecutable: "LivingBot 2", CFBundleIconFile: "LivingBot.icns",
})) execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, join(contents, "Info.plist")]);
for (const helper of (await readdir(join(contents, "Frameworks"))).filter((name) => name.endsWith(".app"))) {
  const plist = join(contents, "Frameworks", helper, "Contents/Info.plist");
  const suffix = helper.replace(/\.app$/, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier app.livingbot.v2.${suffix}`, plist]);
}
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "pipe" });
const zip = join(stage, "LivingBot-2.0.0-dev.1-macos-arm64.zip");
execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
await writeFile(join(stage, "build.json"), JSON.stringify({
  version: "2.0.0-dev.1", electron: "45.0.0", kernel: kernelPackage.version, electronSha256: actual,
  builtAt: new Date().toISOString(),
}, null, 2));
console.log(JSON.stringify({ app, zip, stage }));
