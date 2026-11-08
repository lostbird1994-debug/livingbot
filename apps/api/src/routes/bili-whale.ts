import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import type { BiliWhaleSettings } from "@rakazo/contracts";
import type { RouterContext } from "./context.js";

/**
 * B 站养鱼（bili-whale）的宿主侧接口。
 *
 * 这个功能只属于**一个** bot：它的工具链（30 多个 .mjs 命令）和全部状态都放在
 * 该 bot 自己的文件夹里 —— `<计算机>/bots/<botId>/bili-whale/`。设置页读写的就是
 * 工具链自己读的那份 `config.json`，所以「界面上改了」和「命令行看到的」永远是同一份，
 * 不存在两套状态要同步。
 *
 * 安全边界：
 *   · 每个过程都先过 repos.getBot() —— 不是自己的 bot 一律 IsolationError，路径永远不从入参拼。
 *   · botId → 目录是**扫出来的**，不是猜的；扫不到就明确报「还没初始化」。
 *   · 凭据只写不读：GET 只报「有没有配」，内容一个字都不回显。
 */

const PROJECT_DIR_NAME = "bili-whale";
const CONFIG_FILE_NAME = "config.json";

/**
 * 部署的数据根目录。
 *
 * 顺序不能反：API 进程的工作目录是 `app/apps/api`（由 service.cjs 的 cwd 决定），
 * 拿 cwd 拼 `data` 会落到源码树里，找不到任何 bot。`DATA_DIR` 才是这台机器的真值
 * （environment.json 里写着 `<Rakazo Personal>/data`）。
 */
function dataRoot(): string {
  const configured = process.env.DATA_DIR;
  if (configured) return configured;
  const nativeRoot = process.env.RAKAZO_NATIVE_ROOT;
  if (nativeRoot) return path.join(nativeRoot, "data");
  return path.resolve(process.cwd(), "data");
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 找出某个 bot 的计算机文件夹。
 *
 * 形态有三种，都要认：
 *   homes/<team-key>/bots/<botId>                   团队共享计算机
 *   desktop-computers/<key>/bots/<botId>
 *   native-computers/<kind>/<key>/bots/<botId>      本机原生计算机（多一层）
 */
function findBotDir(botId: string): string | null {
  const base = dataRoot();
  const candidates: string[] = [];

  for (const group of ["homes", "desktop-computers"]) {
    const groupDir = path.join(base, group);
    for (const key of listDirs(groupDir)) candidates.push(path.join(groupDir, key, "bots", botId));
  }

  const nativeDir = path.join(base, "native-computers");
  for (const kind of listDirs(nativeDir)) {
    const kindDir = path.join(nativeDir, kind);
    for (const key of listDirs(kindDir)) candidates.push(path.join(kindDir, key, "bots", botId));
  }

  // 同一台机器上可能有多份同名文件夹（团队家目录 / 原生计算机各一份），
  // 只有真正装着 bili-whale 的那份才是她的工作目录 —— 优先选它，别猜。
  const found = candidates.filter(isDir);
  const carrying = found.find((dir) => isDir(path.join(dir, PROJECT_DIR_NAME)));
  return carrying ?? found[0] ?? null;
}

function projectDirOf(botDir: string): string {
  return path.join(botDir, PROJECT_DIR_NAME);
}

function configPathOf(projectDir: string): string {
  return path.join(projectDir, CONFIG_FILE_NAME);
}

function credentialsPathOf(projectDir: string): string {
  return path.join(projectDir, "data", "home", ".bili-ai", "credentials.json");
}

function planPathOf(projectDir: string): string {
  return path.join(projectDir, "data", "whale-night.json");
}

/** 与 tools/lib/config.mjs 的 DEFAULTS 对齐：文件缺哪项就用这里补，界面永远有完整值。 */
function defaultSettings(): BiliWhaleSettings {
  return {
    persona: { name: "", ownerTitle: "你", selfClaim: "我" },
    owner: { mid: "", name: "" },
    preferences: { like: [], dislike: [] },
    night: {
      windows: [{ start: "20:00", end: "24:00", wakes: 1 }],
      skipChance: 0.3,
      minGapMin: 10,
      maxVideos: 5,
    },
    share: { enabled: true, via: "comment", minScore: 13, silentAfterDays: 3 },
    quota: { shareDaily: 3 },
    listen: {
      comment: false,
      commentIntervalSec: 60,
      dm: false,
      allDay: false,
      live: false,
    },
  };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNum(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readStringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

function readSettings(projectDir: string): BiliWhaleSettings {
  const base = defaultSettings();
  const raw = readJson(configPathOf(projectDir));
  if (!raw) return base;

  const persona = asRecord(raw.persona);
  const owner = asRecord(raw.owner);
  const preferences = asRecord(raw.preferences);
  const night = asRecord(raw.night);
  const share = asRecord(raw.share);
  const quota = asRecord(raw.quota);
  const listen = asRecord(raw.listen);

  const windows = Array.isArray(night.windows)
    ? night.windows
        .map((item) => asRecord(item))
        .filter((item) => typeof item.start === "string" && typeof item.end === "string")
        .map((item) => ({
          start: readText(item.start, base.night.windows[0]!.start),
          end: readText(item.end, base.night.windows[0]!.end),
          wakes: Math.min(3, Math.max(0, Math.round(readNum(item.wakes, 1)))),
        }))
        .slice(0, 3)
    : base.night.windows;

  const via = share.via === "dm" ? "dm" : "comment";

  return {
    persona: {
      name: readText(persona.name, base.persona.name),
      ownerTitle: readText(persona.ownerTitle, base.persona.ownerTitle),
      selfClaim: readText(persona.selfClaim, base.persona.selfClaim),
    },
    owner: {
      mid: readText(owner.mid, ""),
      name: readText(owner.name, ""),
    },
    preferences: {
      like: readStringList(preferences.like, base.preferences.like),
      dislike: readStringList(preferences.dislike, base.preferences.dislike),
    },
    night: {
      windows: windows.length > 0 ? windows : base.night.windows,
      skipChance: Math.min(1, Math.max(0, readNum(night.skipChance, base.night.skipChance))),
      minGapMin: Math.max(0, Math.round(readNum(night.minGapMin, base.night.minGapMin))),
      maxVideos: Math.max(1, Math.round(readNum(night.maxVideos, base.night.maxVideos))),
    },
    share: {
      enabled: readBool(share.enabled, base.share.enabled),
      via,
      minScore: Math.min(20, Math.max(0, Math.round(readNum(share.minScore, base.share.minScore)))),
      silentAfterDays: Math.max(
        1,
        Math.round(readNum(share.silentAfterDays, base.share.silentAfterDays)),
      ),
    },
    quota: { shareDaily: Math.max(0, Math.round(readNum(quota.shareDaily, base.quota.shareDaily))) },
    listen: {
      comment: readBool(listen.comment, base.listen.comment),
      commentIntervalSec: Math.max(
        30,
        Math.round(readNum(listen.commentIntervalSec, base.listen.commentIntervalSec)),
      ),
      dm: readBool(listen.dm, base.listen.dm),
      allDay: readBool(listen.allDay, base.listen.allDay),
      live: readBool(listen.live, base.listen.live),
    },
  };
}

/** 只覆盖设置项，保留文件里其余键（risk / notify / aliases 等），避免把用户手改的东西冲掉。 */
function writeSettings(projectDir: string, settings: BiliWhaleSettings): void {
  const file = configPathOf(projectDir);
  const current = readJson(file) ?? {};
  const next = { ...current, ...settings };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function credentialStates(projectDir: string) {
  const raw = readJson(credentialsPathOf(projectDir));
  const pick = (key: string) => {
    const value = raw?.[key];
    return typeof value === "string" && value.trim().length > 0;
  };
  const sessdata = pick("sessdata");
  const biliJct = pick("bili_jct");
  const buvid3 = pick("buvid3");
  return { configured: sessdata && biliJct, sessdata, biliJct, buvid3 };
}

function readPlan(projectDir: string) {
  const raw = readJson(planPathOf(projectDir));
  if (!raw) return null;
  return {
    action: readText(raw.action, "unknown"),
    atText: typeof raw.atText === "string" ? raw.atText : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

type BiliResult = { ok: boolean; text: string };

function runBili(projectDir: string, args: string[]): Promise<BiliResult> {
  const bin = path.join(projectDir, "bili");
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: path.dirname(projectDir), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = `${String(stdout ?? "")}${String(stderr ?? "")}`.trim();
        resolve({ ok: !error, text });
      },
    );
  });
}

export function biliWhaleRoutes(ctx: RouterContext) {
  const { repos, authed } = ctx;

  /** 校验归属并解析目录；不属于自己 → IsolationError，没初始化 → 明确的 404 语义。 */
  async function resolve(actor: Parameters<typeof repos.getBot>[0], botId: string) {
    await repos.getBot(actor, botId);
    const botDir = findBotDir(botId);
    if (!botDir) {
      throw new ORPCError("NOT_FOUND", {
        message: "这个 bot 还没有自己的文件夹：先和她说一句话，让计算机初始化，再回来。",
      });
    }
    return { botDir, projectDir: projectDirOf(botDir) };
  }

  return {
    biliWhale: {
      get: authed.biliWhale.get.handler(async ({ context, input }) => {
        const { projectDir } = await resolve(context.actor, input.botId);
        const ready = isDir(projectDir) && fs.existsSync(path.join(projectDir, "bili"));
        return {
          settings: ready ? readSettings(projectDir) : defaultSettings(),
          status: {
            projectDir,
            ready,
            credentials: credentialStates(projectDir),
            plan: ready ? readPlan(projectDir) : null,
          },
        };
      }),

      save: authed.biliWhale.save.handler(async ({ context, input }) => {
        const { projectDir } = await resolve(context.actor, input.botId);
        writeSettings(projectDir, input.settings);
        return { ok: true as const };
      }),

      saveCredentials: authed.biliWhale.saveCredentials.handler(async ({ context, input }) => {
        const { projectDir } = await resolve(context.actor, input.botId);
        const file = credentialsPathOf(projectDir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const clean = (value: string) => value.trim().replace(/^["']|["']$/g, "");
        // 与 tools/lib/cred.mjs 读的字段名完全一致（下行下划线，不是驼峰）
        const payload = {
          sessdata: clean(input.sessdata),
          bili_jct: clean(input.biliJct),
          buvid3: clean(input.buvid3),
        };
        fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(file, 0o600);
        return { ok: true as const };
      }),

      deps: authed.biliWhale.deps.handler(async ({ context, input }) => {
        const { projectDir } = await resolve(context.actor, input.botId);
        if (!fs.existsSync(path.join(projectDir, "bili"))) {
          throw new ORPCError("PRECONDITION_FAILED", { message: "工具链还没就位。" });
        }
        const result = await runBili(projectDir, ["deps"]);
        return { text: result.text || "（没有任何输出）" };
      }),

      planNow: authed.biliWhale.planNow.handler(async ({ context, input }) => {
        const { projectDir } = await resolve(context.actor, input.botId);
        // 计划器对「今天已经定过的计划」是幂等的（设计如此：跳过不重抽）。
        // 这个按钮的语义是「现在真掷一次」，所以要先把今天的计划清掉，否则永远返回旧值。
        try {
          fs.rmSync(planPathOf(projectDir), { force: true });
        } catch {
          /* 没有计划文件本来就是想要的状态 */
        }
        const result = await runBili(projectDir, ["night", "plan", "--json"]);
        const parsed = (() => {
          try {
            return JSON.parse(result.text.slice(result.text.indexOf("{"))) as Record<string, unknown>;
          } catch {
            return null;
          }
        })();
        if (!parsed) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: `掷骰子失败：${result.text.slice(0, 200) || "无输出"}`,
          });
        }
        return {
          action: readText(parsed.action, "unknown"),
          atText: typeof parsed.atText === "string" ? parsed.atText : null,
          reason: typeof parsed.reason === "string" ? parsed.reason : null,
        };
      }),
    },
  };
}

