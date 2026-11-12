/**
 * Runs only inside the bot's computer, never in the API process. Input files are written
 * through the computer adapter (0600 on local computers); no cookies appear in argv/output.
 */
export const BILI_WHALE_FILE_SCRIPT = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { randomUUID } = await import("node:crypto");
const { pathToFileURL } = await import("node:url");
const [action, inputName] = process.argv.slice(1);
const project = path.resolve("bili-whale");
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const root = await fs.realpath(".");
const resolved = await fs.realpath(project).catch(error => {
  if (error.code === "ENOENT" && action === "get") return null;
  throw error;
});
if (resolved && !inside(root, resolved)) throw new Error("项目目录不在这个 Bot 的文件夹中");
async function read(file) {
  try {
    const canonical = await fs.realpath(file);
    if (!inside(resolved, canonical)) throw new Error("文件不在养鱼项目目录中");
    const raw = await fs.readFile(canonical, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
    return { raw, value };
  } catch (error) {
    if (error.code === "ENOENT") return { raw: null, value: {} };
    throw error;
  }
}
const configFile = path.join(project, "config.json");
const credentialFile = path.join(project, "data/home/.bili-ai/credentials.json");
const planFile = path.join(project, "data/whale-night.json");
const hasTool = resolved ? await fs.stat(path.join(project, "bili")).then(s => s.isFile()).catch(error => {
  if (error.code === "ENOENT") return false;
  throw error;
}) : false;
if (action === "get") {
  const config = resolved ? await read(configFile) : { value: {} };
  const creds = resolved ? (await read(credentialFile)).value : {};
  const plan = resolved ? await read(planFile) : { raw: null, value: {} };
  const present = key => typeof creds[key] === "string" && creds[key].trim().length > 0;
  console.log(JSON.stringify({
    config: config.value, ready: hasTool,
    credentials: { configured: present("sessdata") && present("bili_jct"),
      sessdata: present("sessdata"), biliJct: present("bili_jct"), buvid3: present("buvid3") },
    plan: plan.raw === null ? null : plan.value,
  }));
} else {
  if (!hasTool) throw new Error("工具链还没就位");
  let file, next, previous, staging;
  if (action === "plan") {
    file = planFile;
    previous = await read(file);
    process.env.DSH_HOME = path.join(project, "data");
    process.env.BILI_WHALE_CONFIG = configFile;
    // Refuse corrupt settings before the toolchain's compatibility reader can hide them.
    await read(configFile);
    const { readNightConfig } = await import(pathToFileURL(path.join(project, "tools/lib/night-config.mjs")));
    const { makePlan, historyOf } = await import(pathToFileURL(path.join(project, "tools/lib/night-plan.mjs")));
    const now = Date.now();
    next = makePlan(readNightConfig(), historyOf(previous.value, now), now);
    if (!next || !["wake", "skip", "done"].includes(next.action) ||
      (next.action !== "done" && (!Number.isFinite(next.atMs) || !Number.isFinite(next.endsAt))))
      throw new Error("新计划无效，原计划已保留");
  } else {
    if (!/^[a-f0-9-]+\.json$/.test(inputName || "")) throw new Error("无效的设置请求");
    staging = path.join(project, "data/.rakazo-settings", inputName);
    const input = (await read(staging)).value;
    file = action === "settings" ? configFile : credentialFile;
    previous = await read(file);
    if (action === "settings") {
      next = { ...previous.value };
      for (const [key, fields] of Object.entries(input)) {
        next[key] = { ...((next[key] && typeof next[key] === "object") ? next[key] : {}), ...fields };
      }
    } else if (action === "credentials") {
      next = { ...previous.value };
      for (const key of ["sessdata", "bili_jct", "buvid3"]) {
        const value = typeof input[key] === "string" ? input[key].trim().replace(/^["']+|["']+$/g, "") : "";
        if (value) next[key] = value;
      }
      if (!next.sessdata || !next.bili_jct) throw new Error("请同时提供 SESSDATA 和 bili_jct；已有凭据保持不变");
    } else throw new Error("未知操作");
  }
  const parent = path.dirname(file);
  await fs.mkdir(parent, { recursive: true });
  if (!inside(resolved, await fs.realpath(parent))) throw new Error("目标目录不在养鱼项目中");
  if (!staging) staging = path.join(parent, "." + path.basename(file) + "." + randomUUID() + ".tmp");
  // Prepare and verify the entire replacement before changing the existing file.
  await fs.writeFile(staging, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: action === "plan" ? "wx" : "w" });
  await fs.chmod(staging, 0o600);
  JSON.parse(await fs.readFile(staging, "utf8"));
  if ((await read(file)).raw !== previous.raw) throw new Error("文件刚被其他任务更新，请重试；原文件已保留");
  await fs.rename(staging, file);
  console.log(JSON.stringify(action === "plan" ? next : { ok: true }));
}
`;
