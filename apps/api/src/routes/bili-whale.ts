import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AdapterContext, CommandRequest } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { ComputerExecutionLease } from "@rakazo/adapters";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  releaseComputerExecutionLease,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor, BiliWhaleSettings } from "@rakazo/contracts";
import { BiliWhaleSettingsSchema } from "@rakazo/contracts";
import { parseComputerMode } from "@rakazo/db";
import { BILI_WHALE_FILE_SCRIPT } from "./bili-whale-computer.js";
import type { RouterContext } from "./context.js";

/**
 * B 站养鱼（bili-whale）的宿主侧接口。
 *
 * 这个功能只属于**一个** bot：它的工具链（30 多个 .mjs 命令）和全部状态都放在
 * 该 bot 自己的文件夹里 —— `<计算机>/bots/<botId>/bili-whale/`。设置页读写的就是
 * 工具链自己读的那份 `config.json`，所以「界面上改了」和「命令行看到的」永远是同一份，
 * 不存在两套状态要同步。
 *
 * All file access and commands use the bot's assigned computer. The API neither scans the
 * host filesystem nor executes a workspace script with its own service environment.
 */

const PROJECT_DIR_NAME = "bili-whale";

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
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

export function readBiliWhaleSettings(raw: Record<string, unknown>): BiliWhaleSettings {
  const base = defaultSettings();

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

  const settings = {
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
    quota: {
      shareDaily: Math.max(0, Math.round(readNum(quota.shareDaily, base.quota.shareDaily))),
    },
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
  const validated = BiliWhaleSettingsSchema.safeParse(settings);
  if (!validated.success) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "养鱼配置中有无效的时间或超出范围的数值，请先修正 config.json；原文件未修改。",
    });
  }
  return validated.data;
}
function readPlan(raw: Record<string, unknown> | null) {
  if (raw === null) return null;
  return {
    action: readText(raw.action, "unknown"),
    atText: typeof raw.atText === "string" ? raw.atText : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

export function biliWhaleRoutes(ctx: RouterContext) {
  const { deps, repos, authed } = ctx;
  async function resolve(actor: Actor, botId: string) {
    const bot = await repos.getBot(actor, botId);
    if (bot.spawnKey !== PROJECT_DIR_NAME) throw new ORPCError("FORBIDDEN");
    if (!bot.computer?.providerRef || bot.computer.state !== "running") {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "请先启动这个 Bot 的计算机，再打开养鱼设置。",
      });
    }
    return { bot, computer: bot.computer, ref: toComputerRef(bot.computer) };
  }

  async function execute(
    target: Awaited<ReturnType<typeof resolve>>,
    request: CommandRequest,
    context: AdapterContext,
  ) {
    let output = "";
    let exit: number | undefined;
    for await (const event of deps.sandbox.execute(
      target.ref,
      { timeoutMs: 120_000, ...request },
      context,
    )) {
      if (event.type === "exit") exit = event.code;
      else if (event.type === "stdout") output += event.data;
      if (output.length > 1024 * 1024)
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "工具输出过长。" });
    }
    if (exit !== 0)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "养鱼操作未完成，请检查工具链、配置和凭据后重试。",
      });
    return output;
  }

  async function operation(
    actor: Actor,
    botId: string,
    action: "get" | "settings" | "credentials" | "deps" | "plan",
    input?: object,
    signal?: AbortSignal,
  ) {
    const target = await resolve(actor, botId);
    const scope = parseComputerMode(target.computer.scope);
    const runId = `bili-whale:${randomUUID()}`;
    const context = {
      ...createAdapterContext(actor, botId, runId),
      runId,
      ...(signal ? { signal } : {}),
    };
    let lease: ComputerExecutionLease | null = null;
    try {
      if (action !== "get")
        lease = await acquireComputerExecutionLease(deps.prisma, {
          computerId: target.computer.id,
          botId,
          runId,
        });
      const inputName = `${randomUUID()}.json`;
      if (input) {
        await deps.sandbox.writeFile(
          target.ref,
          {
            path: resolveBotWorkspacePath(
              scope,
              botId,
              `${PROJECT_DIR_NAME}/data/.rakazo-settings/${inputName}`,
            ),
            content: Buffer.from(JSON.stringify(input)),
          },
          context,
        );
      }
      const output = await execute(
        target,
        action === "deps"
          ? {
              argv: ["./bili", "deps"],
              cwd: resolveBotWorkspaceCwd(scope, botId, PROJECT_DIR_NAME),
            }
          : {
              argv: [
                "node",
                "--input-type=module",
                "-e",
                BILI_WHALE_FILE_SCRIPT,
                action,
                inputName,
              ],
              cwd: resolveBotWorkspaceCwd(scope, botId, "."),
            },
        context,
      );
      return action === "deps" ? { text: output || "（没有任何输出）" } : JSON.parse(output);
    } catch (error) {
      if (error instanceof ComputerBusyError)
        throw new ORPCError("CONFLICT", { message: "这个 Bot 的计算机正在执行任务，请稍后重试。" });
      throw error;
    } finally {
      await releaseComputerExecutionLease(deps.prisma, lease);
    }
  }

  return {
    biliWhale: {
      get: authed.biliWhale.get.handler(async ({ context, input }) => {
        const result = await operation(
          context.actor,
          input.botId,
          "get",
          undefined,
          context.signal,
        );
        return {
          settings: readBiliWhaleSettings(asRecord(result.config)),
          status: {
            projectDir: PROJECT_DIR_NAME,
            ready: result.ready,
            credentials: result.credentials,
            plan: readPlan(result.plan),
          },
        };
      }),

      save: authed.biliWhale.save.handler(async ({ context, input }) => {
        await operation(context.actor, input.botId, "settings", input.settings, context.signal);
        return { ok: true as const };
      }),

      saveCredentials: authed.biliWhale.saveCredentials.handler(async ({ context, input }) => {
        await operation(
          context.actor,
          input.botId,
          "credentials",
          {
            sessdata: input.sessdata,
            bili_jct: input.biliJct,
            buvid3: input.buvid3,
          },
          context.signal,
        );
        return { ok: true as const };
      }),

      deps: authed.biliWhale.deps.handler(async ({ context, input }) => {
        return operation(context.actor, input.botId, "deps", undefined, context.signal);
      }),

      planNow: authed.biliWhale.planNow.handler(async ({ context, input }) => {
        return readPlan(
          await operation(context.actor, input.botId, "plan", undefined, context.signal),
        )!;
      }),
    },
  };
}
