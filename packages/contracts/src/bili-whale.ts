import * as z from "zod";

/**
 * B 站养鱼（bili-whale）附加设置。
 *
 * 这些设置属于「某一个 bot」，不属于整个空间：它们决定那条鱼怎么过日子 ——
 * 什么时候醒、爱看什么、一天最多打扰主人几次。存储位置是 bot 自己文件夹里的
 * `bili-whale/config.json`，工具链与设置页读写同一份文件，改哪边都立刻生效。
 */
export const BiliWhalePersonaSchema = z.object({
  /** 角色名；留空则用 bot 名字。 */
  name: z.string().max(40),
  /** 怎么称呼使用者。 */
  ownerTitle: z.string().max(40),
  /** 怎么自称。 */
  selfClaim: z.string().max(40),
});

export const BiliWhaleOwnerSchema = z.object({
  /** 分享评论里要 @ 的人的 mid。 */
  mid: z.string().max(40),
  /** 缓存昵称，@ 人时用；改过昵称要重新校准。 */
  name: z.string().max(60),
});

export const BiliWhaleWindowSchema = z.object({
  /** HH:MM，"24:00" 表示当天结束。 */
  start: z.string().regex(/^\d{1,2}:\d{2}$/, "时间格式应为 HH:MM"),
  end: z.string().regex(/^\d{1,2}:\d{2}$/, "时间格式应为 HH:MM"),
  /** 这个窗口里醒几次（0 = 不醒）；代码侧硬上限 3。 */
  wakes: z.number().int().min(0).max(3),
});

export const BiliWhaleNightSchema = z.object({
  windows: z.array(BiliWhaleWindowSchema).max(3),
  /** 今天不想看的概率，0–1。 */
  skipChance: z.number().min(0).max(1),
  /** 两次醒来之间至少隔多少分钟。 */
  minGapMin: z.number().int().min(0).max(240),
  /** 每次醒来最多看几条。 */
  maxVideos: z.number().int().min(1).max(20),
});

export const BiliWhaleShareSchema = z.object({
  enabled: z.boolean(),
  /** comment = 在评论区 @ 主人；dm = B 站私信（需要两个号且互关）。 */
  via: z.enum(["comment", "dm"]),
  /** 分享打分门槛，0–20；低于它就不发。 */
  minScore: z.number().int().min(0).max(20),
  /** 连续多少天没得到回应后开始降低分享额度。 */
  silentAfterDays: z.number().int().min(1).max(60),
});

export const BiliWhaleListenSchema = z.object({
  /** 评论区监听（每轮都会真的请求一次，新号建议关）。 */
  comment: z.boolean(),
  commentIntervalSec: z.number().int().min(30).max(3600),
  /** 私信监听：只有主人一个对话方，最省 token。 */
  dm: z.boolean(),
  /** 全天监听还是只在作息窗口内。 */
  allDay: z.boolean(),
  /** 直播间弹幕。 */
  live: z.boolean(),
});

export const BiliWhaleSettingsSchema = z.object({
  persona: BiliWhalePersonaSchema,
  owner: BiliWhaleOwnerSchema,
  preferences: z.object({
    like: z.array(z.string().max(80)).max(30),
    dislike: z.array(z.string().max(80)).max(30),
  }),
  night: BiliWhaleNightSchema,
  share: BiliWhaleShareSchema,
  quota: z.object({ shareDaily: z.number().int().min(0).max(10) }),
  listen: BiliWhaleListenSchema,
});
export type BiliWhaleSettings = z.infer<typeof BiliWhaleSettingsSchema>;

/** 凭据状态只报「有没有」，永远不回显内容。 */
export const BiliWhaleCredentialStateSchema = z.object({
  configured: z.boolean(),
  sessdata: z.boolean(),
  biliJct: z.boolean(),
  buvid3: z.boolean(),
});

/** 今晚的计划：action 是 wake / skip / done 之一。 */
export const BiliWhalePlanSchema = z.object({
  action: z.string(),
  atText: z.string().nullable(),
  reason: z.string().nullable(),
});

export const BiliWhaleStatusSchema = z.object({
  /** 项目目录（工具链所在处），用来告诉用户文件在哪。 */
  projectDir: z.string(),
  /** 工具链是否就位。 */
  ready: z.boolean(),
  credentials: BiliWhaleCredentialStateSchema,
  plan: BiliWhalePlanSchema.nullable(),
});
export type BiliWhaleStatus = z.infer<typeof BiliWhaleStatusSchema>;
