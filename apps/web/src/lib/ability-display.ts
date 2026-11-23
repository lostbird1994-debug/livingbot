import type { Ability } from "../../../../packages/workbench/src/contracts";

type DisplayCopy = readonly [name: string, description: string];
export type AbilityDisplay = {
  name: string;
  description: string;
  originalName: string;
  type: "技能" | "应用连接" | "工具";
  origin: "系统内置" | "自行添加";
};

// Display copy reviewed against the local OpenClaw skill manifests.
// Keep machine-specific provenance and original descriptions out of this catalog.
const skills: Readonly<Record<string, DisplayCopy>> = {
  "1password": ["1Password 密码管理", "通过 1Password 命令行读取或注入所需凭据"],
  "apple-notes": ["苹果备忘录", "创建、查找、编辑和导出苹果备忘录"],
  "apple-reminders": ["苹果提醒事项", "管理提醒事项、清单和完成状态"],
  "bear-notes": ["Bear 笔记", "创建、搜索和管理 Bear 笔记"],
  blogwatcher: ["博客订阅", "跟踪博客和 RSS 订阅的更新"],
  blucli: ["BluOS 音响控制", "发现 BluOS 设备并控制播放、分组和音量"],
  bluebubbles: ["BlueBubbles 消息", "通过 BlueBubbles 收发和管理 iMessage 消息"],
  camsnap: ["摄像头画面", "从网络摄像头或本机摄像头截取画面和片段"],
  canvas: ["画布展示", "在连接的画布面板中展示内容并控制显示"],
  clawhub: ["ClawHub 扩展管理", "搜索、安装和更新 ClawHub 插件与技能"],
  "coding-agent": ["编程代理协作", "将编程任务交给 Codex 等编程代理执行"],
  "control-ui": ["OpenClaw 控制台", "操作控制台、整理会话并排查连接问题"],
  "create-template": ["创建代理模板", "将当前代理整理成可分享和审阅的模板"],
  "diagram-maker": ["绘制图解", "为概念、架构和流程制作图解"],
  discord: ["Discord 社群消息", "通过消息工具管理 Discord 消息和频道"],
  eightctl: ["Eight Sleep 睡眠设备", "查看和控制 Eight Sleep 温度、闹钟与计划"],
  gemini: ["Gemini 命令行", "通过 Gemini 命令行提问、总结和生成内容"],
  "gh-issues": ["GitHub 问题协作", "读取 GitHub 问题并协作修复和处理审查意见"],
  gifgrep: ["动图搜索", "搜索和下载动图并提取静态画面"],
  github: ["GitHub 仓库协作", "管理 GitHub 问题、合并请求和持续集成结果"],
  gog: ["Google 办公套件", "处理 Google 邮件、日历、云盘和办公文档"],
  goplaces: ["Google 地点搜索", "搜索地点并查看地址、详情和评价"],
  healthcheck: ["主机安全检查", "检查主机访问、更新、备份和安全配置"],
  himalaya: ["Himalaya 邮件管理", "通过 IMAP 和 SMTP 阅读、搜索和发送邮件"],
  imsg: ["苹果信息", "查看 iMessage 和短信记录并发送消息"],
  mcporter: ["MCP 服务管理", "配置、连接和调用 MCP 服务与工具"],
  "meme-maker": ["制作表情梗图", "搜索梗图模板并制作图片"],
  "model-usage": ["模型用量统计", "汇总本机记录中的模型用量和费用"],
  "nano-pdf": ["PDF 编辑", "用自然语言指令修改 PDF 文档"],
  "node-connect": ["设备连接排查", "排查浏览器和移动设备的授权、配对与连接问题"],
  "node-inspect-debugger": ["Node.js 调试", "使用断点和性能分析工具调试 Node.js 程序"],
  notion: ["Notion 文档管理", "搜索和管理 Notion 页面、文件与数据源"],
  obsidian: ["Obsidian 知识库", "查找和编辑 Obsidian 笔记、任务与链接"],
  "openai-whisper": ["Whisper 本机转写", "在本机将语音转成文字"],
  "openai-whisper-api": ["OpenAI 语音转写", "通过 OpenAI 语音接口将音频转成文字"],
  openhue: ["飞利浦 Hue 灯光", "控制 Hue 灯光和场景"],
  oracle: ["Oracle 模型复核", "将选定文件交给另一模型审阅、调试或分析"],
  ordercli: ["Foodora 订单查询", "查看 Foodora 历史订单和当前订单状态"],
  peekaboo: ["Peekaboo 桌面操作", "截取 macOS 界面并执行桌面交互"],
  "python-debugpy": ["Python 调试", "通过断点、交互调试或远程附加排查 Python 程序"],
  sag: ["ElevenLabs 语音朗读", "通过 ElevenLabs 将文字转换为语音"],
  "session-logs": ["会话日志检索", "搜索和分析历史会话日志"],
  "sherpa-onnx-tts": ["离线语音朗读", "在本机离线将文字转换为语音"],
  "skill-creator": ["技能编写", "创建、审阅和修整技能说明及配套资源"],
  slack: ["Slack 工作消息", "管理 Slack 消息、回应和置顶内容"],
  songsee: ["音频特征可视化", "从音频生成频谱图和特征图"],
  sonoscli: ["Sonos 音响控制", "发现 Sonos 音响并控制播放、音量和分组"],
  spike: ["可行性原型验证", "用短期原型验证方案并比较可行性"],
  "spotify-player": ["Spotify 音乐播放", "搜索 Spotify 音乐并控制播放"],
  summarize: ["内容摘要与转写", "总结网页、视频、播客和本机文件的内容"],
  taskflow: ["多步任务协调", "协调多步任务的执行状态、等待和子任务"],
  "taskflow-inbox-triage": ["收件箱分流示例", "演示收件分流、等待回复和后续汇总流程"],
  "things-mac": ["Things 待办管理", "管理 Things 3 待办事项、项目和标签"],
  tmux: ["终端会话控制", "控制 tmux 终端会话并读取程序输出"],
  trello: ["Trello 看板管理", "管理 Trello 看板、列表和卡片"],
  "video-frames": ["视频画面提取", "从视频提取静态画面或短片段"],
  visualize: ["交互可视化", "为内容创建可视化展示或仪表盘组件"],
  "voice-call": ["语音通话", "通过语音通话插件发起通话"],
  wacli: ["WhatsApp 消息管理", "发送 WhatsApp 消息并同步和搜索历史记录"],
  weather: ["天气查询", "查询当前天气和天气预报"],
  xurl: ["X 平台操作", "发布和搜索 X 帖子并管理回复与私信"],
  "add-model-provider": ["添加模型连接", "配置模型提供方并验证连接是否可用"],
  "cloud-image-bake": ["云工作环境镜像", "制作、选择和验证云工作环境镜像"],
  "configure-channel": ["消息渠道配置", "配置消息渠道并验证连接"],
  "diagnose-gateway": ["网关故障排查", "只读检查网关、配置和渠道连接故障"],
  "acp-router": ["编程代理路由", "将编程协作请求交给相应的代理会话"],
  "browser-automation": ["浏览器自动化", "操作网页并处理多步交互和页面状态恢复"],
};

const tools: Readonly<Record<string, DisplayCopy>> = {
  read: ["读取文件", "读取文件内容"],
  write: ["创建文件", "将内容写入指定文件"],
  edit: ["修改文件", "替换文件中的指定内容"],
  apply_patch: ["精确修改文件", "通过补丁修改文件内容"],
  ls: ["浏览文件夹", "列出文件夹中的文件"],
  exec: ["运行本机命令", "执行本机命令并读取结果"],
  process: ["管理运行程序", "查看运行中的程序并与其交互"],
  memory_search: ["检索记忆", "搜索已保存的记忆和相关记录"],
  memory_get: ["读取记忆来源", "读取记忆来源中的指定内容"],
  ask_user: ["向你提问", "请求完成任务所需的信息"],
  web_search: ["搜索网页", "搜索网络上的相关资料"],
  web_fetch: ["阅读网页", "获取指定网页的内容"],
  browser: ["操作浏览器", "浏览网页并执行页面交互"],
  cron: ["定时任务", "安排和管理定时工作"],
  image: ["查看图片", "读取和分析图片内容"],
  imagegen: ["生成图片", "根据要求生成或编辑图片"],
  sessions_create: ["创建会话", "创建用于处理任务的新会话"],
  sessions_history: ["查阅会话记录", "读取指定会话的历史消息"],
  sessions_list: ["查看会话", "列出可访问的会话"],
  sessions_spawn: ["分派协作任务", "创建代理协作任务"],
  sessions_send: ["发送会话消息", "向指定会话发送消息"],
  sessions_yield: ["等待协作结果", "等待协作任务返回结果"],
  sessions_search: ["搜索会话", "在可访问的会话记录中搜索内容"],
  session_status: ["查看会话状态", "查看当前会话的运行状态"],
  message: ["发送消息", "通过已连接的消息渠道发送和管理消息"],
  canvas: ["控制画布", "在连接的画布中展示内容"],
  nodes: ["管理连接设备", "查看和操作已连接的设备"],
  gateway: ["管理网关", "查看和调整网关运行配置"],
  agents_list: ["查看可用代理", "列出可参与协作的代理"],
  subagents: ["管理协作代理", "查看和管理已分派的代理任务"],
  tts: ["文字转语音", "将文字转换为语音"],
  pdf: ["阅读 PDF", "读取和分析 PDF 文档"],
  video: ["分析视频", "读取和分析视频内容"],
  livingbot_conversations: ["回顾对话", "查找和读取已有对话"],
  livingbot_deliver_file: ["交付文件", "将完成的文件交付到对话中"],
  livingbot_report_privately: ["私聊汇报", "通过私聊汇报任务进展或结果"],
  livingbot_assign_group: ["分派群内工作", "将群内工作分派给相应伙伴"],
  call_user: ["语音来电", "向你发起语音通话"],
  end_call: ["结束通话", "结束当前语音通话"],
};

const addedBrands: Readonly<Record<string, DisplayCopy>> = {
  "livingbot-ima": ["腾讯 IMA 知识库", "搜索和使用腾讯 IMA 知识库内容"],
  "tencent-ima": ["腾讯 IMA 知识库", "搜索和使用腾讯 IMA 知识库内容"],
  ima: ["腾讯 IMA 知识库", "搜索和使用腾讯 IMA 知识库内容"],
  腾讯ima: ["腾讯 IMA 知识库", "搜索和使用腾讯 IMA 知识库内容"],
  "livingbot-feishu": ["飞书 CLI", "通过飞书命令行处理消息、文档和协作事务"],
  "feishu-cli": ["飞书 CLI", "通过飞书命令行处理消息、文档和协作事务"],
  飞书cli: ["飞书 CLI", "通过飞书命令行处理消息、文档和协作事务"],
  "livingbot-ego-browser": ["Ego 浏览器", "通过 Ego 浏览器操作网页"],
  "ego-browser": ["Ego 浏览器", "通过 Ego 浏览器操作网页"],
  "livingbot-qq-email": ["QQ 邮箱", "通过 QQ 邮箱收发和查找邮件"],
  "qq-email": ["QQ 邮箱", "通过 QQ 邮箱收发和查找邮件"],
  "qq-mail": ["QQ 邮箱", "通过 QQ 邮箱收发和查找邮件"],
  qq邮箱: ["QQ 邮箱", "通过 QQ 邮箱收发和查找邮件"],
};

const builtinSources = new Set([
  "builtin",
  "built-in",
  "core",
  "livingbot",
  "openclaw-bundled",
  "openclaw-custodian",
]);
const addedSources = new Set([
  "private",
  "migrated",
  "workspace",
  "managed",
  "marketplace",
  "mcp",
  "openclaw-workspace",
  "openclaw-managed",
  "agents-skills-personal",
  "agents-skills-project",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Character detection only; this does not judge the meaning of prose.
function hasChinese(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

/** List presentation only. The Ability and its original detail copy stay untouched. */
export function abilityDisplay(ability: Ability): AbilityDisplay {
  const native = record(ability.configuration?.native);
  const originalName = text(native.nativeName) || text(ability.name);
  const key = originalName.toLowerCase();
  const type: AbilityDisplay["type"] =
    native.nativeKind === "tool"
      ? "工具"
      : ability.kind === "service" ||
          ability.kind === "connector" ||
          native.nativeKind === "service"
        ? "应用连接"
        : native.nativeKind === "skill" || ability.kind === "method"
          ? "技能"
          : "工具";
  const sources = [text(native.nativeSource), text(native.source), ability.source];
  const source = sources.find(Boolean) ?? "";
  const brand = Object.hasOwn(addedBrands, key) ? addedBrands[key] : undefined;
  const builtin =
    !brand &&
    !sources.some((source) => addedSources.has(source)) &&
    (native.bundled === true || builtinSources.has(source));
  const origin = builtin ? "系统内置" : "自行添加";
  const catalog = type === "技能" ? skills : type === "工具" ? tools : undefined;
  const known = catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  const chineseName = hasChinese(ability.name)
    ? text(ability.name)
    : hasChinese(originalName)
      ? originalName
      : undefined;
  const fallbackName = `${type === "技能" ? "扩展技能" : type === "应用连接" ? "应用连接" : "扩展工具"}${originalName ? `（${originalName}）` : ""}`;
  const description = text(ability.description);
  const chineseDescription =
    hasChinese(description) && description.length <= 100
      ? description
      : "查看详情以了解这项扩展能力";
  return {
    name:
      brand?.[0] ??
      (!builtin && chineseName ? chineseName : (known?.[0] ?? chineseName ?? fallbackName)),
    description:
      brand?.[1] ??
      (!builtin && chineseName ? chineseDescription : (known?.[1] ?? chineseDescription)),
    originalName,
    type,
    origin,
  };
}
