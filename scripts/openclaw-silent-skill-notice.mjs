import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SIGNATURE = "async function postWorkshopChangeNotice(e) {";
const SILENT_NOTICE = `${SIGNATURE}\n\tif (e.changes.length === 0) return;\n\tlog.debug("skill workshop changes saved silently");\n}`;

export function patchSkillWorkshopNotice(source) {
  if (source.includes(SILENT_NOTICE)) return source;
  const start = source.indexOf(SIGNATURE);
  const regionEnd = source.indexOf("\n//#endregion", start);
  if (start < 0 || regionEnd < 0 || source.indexOf(SIGNATURE, start + SIGNATURE.length) >= 0) {
    throw new Error("Skill workshop notice anchor is missing or ambiguous; nothing changed");
  }
  const end = source.lastIndexOf("\n}", regionEnd);
  if (end < start) throw new Error("Skill workshop notice boundary is invalid; nothing changed");
  return source.slice(0, start) + SILENT_NOTICE + source.slice(end + 2);
}

export async function applySilentSkillNoticePatch(runtime, backupRoot = join(homedir(), ".openclaw/backups")) {
  const dist = join(runtime, "dist");
  const files = (await readdir(dist)).filter((name) => /^experience-review-.*\.mjs$/.test(name));
  const matches = [];
  for (const name of files) {
    const file = join(dist, name);
    const before = await readFile(file, "utf8");
    if (before.includes(SIGNATURE)) matches.push({ file, before });
  }
  if (matches.length !== 1) throw new Error(`Expected one skill workshop notice module; found ${matches.length}`);
  const [{ file, before }] = matches;
  const after = patchSkillWorkshopNotice(before);
  const check = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: after, encoding: "utf8" });
  if (check.status !== 0) throw new Error(check.stderr || "Syntax check failed; nothing changed");
  if (after === before) return { changed: false };

  const backupDir = join(backupRoot, `skill-workshop-notice-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, basename(file));
  await copyFile(file, backup);
  if (await readFile(backup, "utf8") !== before) throw new Error("Runtime backup verification failed; nothing changed");
  if (await readFile(file, "utf8") !== before) throw new Error("Runtime changed during patch preparation; nothing changed");
  try {
    await writeFile(file, after);
    if (await readFile(file, "utf8") !== after) throw new Error("Runtime write verification failed");
  } catch (error) {
    await copyFile(backup, file);
    throw error;
  }
  return { changed: true, file, backup };
}
