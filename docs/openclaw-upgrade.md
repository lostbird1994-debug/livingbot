# OpenClaw 运行时升级备忘

本仓库带一个针对 **本机 OpenClaw 运行时**的本地补丁：给 `exec` 工具加一个**必填的 `description`** 参数。
升级 OpenClaw 会换一个新的运行时目录，补丁不在里面，聊天里的执行过程会退回显示原始命令。**升级后请按本文重打。**

## 为什么需要这个补丁

聊天里的“执行过程”每一行要说明**在做什么**，而不是**在跑哪个程序**。我们的 pi 运行时工具是自己定义的，schema 想加什么字段就加什么；但 `AGENT_RUNTIME=openclaw` 时，`exec` / `read` / `apply_patch` 是内核自带工具，schema 由内核决定，只有 `command`、`workdir` 等字段，没有地方写“意图”。

WorkBuddy 的做法是给它的 shell 工具一个必填的 `description` 参数，界面显示这句话、不显示命令。补丁让 `exec` 拥有同样的字段，取同一套机制。

**注意这是“声明必填”，不是“运行时强制”**：和 WorkBuddy 一样，模型若跳过该字段，命令照常执行（实测过：故意省略 `description` 调用它的 shell 工具，仍然成功）。区别只在“模型看到多少提示”——补丁把要求写进两处：参数本身的说明，以及 exec 工具说明正文里的那句 `Always pass description…`。模型遵守时每行就是人话；不遵守时界面退回命令归纳。

链路：`exec(args.description)` → `toolCallAction()`（`packages/adapters/src/tool-activity-text.ts`）→ `steps[].action` → 聊天行文本。
渲染优先级：`action`（模型写的意图）→ 命令归纳（`apps/web/src/lib/command-action.ts`）→ 动词 + 目标 → 原命令。命令始终保留在该行的悬停提示里。

没有补丁也能跑，只是会一直用到第 2、3 级兜底。

## 日常打补丁

```bash
node scripts/patch-openclaw-exec-description.mjs
```

脚本是幂等的：已打过会直接跳过；改前把原文件备份到 `~/.openclaw/backups/exec-schema-<时间>.js`；找不到预期的代码锚点会报错退出，不做猜测。
它改两个文件（都在 `.../OpenClaw-runtime-<版本>/lib/node_modules/openclaw/dist/`）：

- `bash-tools.schemas-*.js`：`execSchema` 增加必填 `description`；
- `bash-tools.descriptions-*.js`：exec 工具说明正文里加一句“每次调用都必须带 description”。

补丁只在本地生效，不进依赖，也不随仓库分发。写盘后脚本会用 `node --check` 解析一遍，通不过就**自动回滚**——因为改坏这个文件会让所有运行报 `SyntaxError`。

## 升级后的检查清单

1. **确认新运行时目录**：检查本机安装器生成的 OpenClaw 运行时目录。脚本默认在它支持的本机安装布局中选择运行时；其他安装方式需先确认路径。
2. **打补丁**：`node scripts/patch-openclaw-exec-description.mjs`，确认输出 `Patched …` 或 `Already patched …`。
3. **验证字段真的必填**：
   ```bash
   cd <运行时目录>
   node --input-type=module -e "const m = await import('file://' + process.cwd() + '/dist/' + (await import('node:fs')).readdirSync('dist').find(f => f.startsWith('bash-tools.schemas-'))); console.log(m.t.required)"
   ```
   应输出 `[ 'command', 'description' ]`。
4. **重启内核网关**：`openclaw gateway restart`。
   网关是常驻进程（默认 18789 端口），只重启应用的代理桥接服务不会重启它；不重启则新 schema 不会加载。
   重启会中断正在跑的任务。请等待应用和共享渠道的任务全部结束后再重启。
5. **重建并重启 LivingBot**（改了适配器/前端时）：按实际部署方式生成候选构建、备份现有产物，在空闲窗口切换 API、worker 和 web 服务，并检查健康状态。
6. **真机验证**：让一个 bot 跑一条 `exec` 命令，然后导出该会话看数据：
   ```bash
   cd apps/api && npx tsx src/cli/content-encryption.ts export --thread <threadId> --output /tmp/t.jsonl
   ```
   最后一条 bot 消息的 `steps[]` 里应出现 `"tool": "exec"`、`"action": "列出当前目录文件"` 这样的字段，以及 `durationMs`。
7. **顺带确认飞书等其它渠道**正常（它们共用同一个运行时；模型会多填一个字段，UI 不使用它）。

## 回滚

- 用备份覆盖：`~/.openclaw/backups/exec-schema-<时间>.js` → 对应 `dist/bash-tools.schemas-*.js`。
- 或原地把 `description: Type.String({...})` 改成 `Type.Optional(Type.String({...}))`，字段变成可选：模型不填也不会校验失败，界面退回命令归纳。

## 风险

- **必填只是声明**：模型不填时调用不会被拒，界面退回命令归纳（“列出文件 / 查看文件”那种）。想真正强制，只能在内核执行 exec 前校验参数并返回错误让模型重试；那属于改执行路径，当前没做。
- **模型差异**：不同模型和兼容端点对 `description` 声明的遵守情况可能不同，应检查实际工具事件，不能仅凭配置认定字段已送达。
- **影响面**：这个运行时同时服务飞书等渠道，不只是聊天界面。
- **升级漂移**：内核若重写工具定义（字段名或结构变化），脚本会因找不到锚点而失败——这是设计成“宁可报错不改错”，看到报错请人工确认后再改脚本。

## 思考流与自定义连接

思考等级和思考可见性是两个设置。LivingBot 的可信本机 kernel 在新会话上通过
`sessions.patch` 设置 `reasoningLevel: "stream"`；模型等级为 `off` 时设置为 `off`。
普通外部连接不申请管理员权限，也不修改网关会话设置。升级后应用：

```bash
node scripts/patch-openclaw-reasoning-stream.mjs
node scripts/patch-openclaw-reasoning-compat.mjs
```

脚本默认选择适配器实际解析到的 SDK 运行时；也可传 `--runtime <运行时绝对路径>`。
修改前先检查锚点唯一性和 JavaScript 语法，并保存备份；写入或校验失败会还原。
脚本不重启网关。应在共享网关的任务结束后统一加载更新。

第一个补丁将会话的可见性传到 embedded agent，默认仍为 `off`，并修正旧补丁
对所有会话默认开启流的行为。第二个补丁将模型的
`compat.reasoningEffortMap` 转成内置 pi-ai 所读取的 `thinkingLevelMap`。
这一步不能用单独调用 OpenClaw transport 的构造函数代替验收：2026.5.7
的 embedded agent 可以走 pi-ai 的会话传输，两条路径读取的映射字段不同。

对明确要求 DeepSeek 请求格式的兼容端点，使用模型现有的兼容配置，例如：

```json
{
  "reasoning": true,
  "compat": {
    "supportsReasoningEffort": true,
    "thinkingFormat": "deepseek",
    "supportedReasoningEfforts": ["low", "high", "xhigh"],
    "reasoningEffortMap": {
      "minimal": "low",
      "low": "low",
      "medium": "high",
      "high": "high",
      "xhigh": "xhigh"
    }
  }
}
```

该示例是端点兼容策略，不是所有同名模型的默认值。内置 pi-ai 已支持
`thinkingFormat: "deepseek"`，会发送 `thinking.type` 开关；不需要根据模型名
猜测开关。若还使用 OpenClaw 自有 completions transport，
`patch-openclaw-deepseek-thinking.mjs` 为它补齐同一显式兼容开关，同时替换旧版
按模型名匹配的补丁。

模型返回的思考以独立 `reasoning` block 保存，和工具步骤依次排列；
不进入回复正文、引用和通知。在 web/Electron 中随“显示执行过程”开关显示，
运行时展开、完成后收起。原生移动端目前和工具步骤一样隐藏这类执行详情，
仍显示回复正文，预览也不会带出思考。

离线补丁契约检查：

```bash
node --test scripts/openclaw-reasoning-patches.test.mjs
```

配置上线前应对选定运行时执行隔离网关验收：本地模拟 completions 返回思考、
工具调用和最终回复，检查最终请求参数、WS 思考帧、驱动回调以及 `off`。
仅有模型轨迹里的 `reasoning_content` 不能证明整条展示链路已接通。
