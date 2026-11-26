严禁防御性思维代码，不应为极小概率发生的情况去考虑开发，一切以用户体验为最高目标，严禁过度设置权限。

# 开发指南

## 当前项目入口

当前工作区是 2.0：桌面应用使用 `apps/web` 的既有界面，通过
`apps/workbench` 连接 `packages/workbench` 产品层及原生内核。
`apps/workbench-web` 是早期替代界面，不作为当前桌面交付入口。
1.0 的 API、Worker 和部署说明作为继承参考保留。

| 目录或文件 | 用途 |
| --- | --- |
| `apps/web/src` | 当前网页及桌面共用界面 |
| `apps/workbench/src` | 本地 HTTP 服务、系统设置与原生功能接线 |
| `apps/workbench-desktop` | Electron 主进程、启动与打包 |
| `packages/workbench/src` | 会话、任务、例行任务、能力、体检和产品记录 |
| `packages/kernel-runtime` | 原生内核生命周期、配置及插件 |
| `packages/contracts`、`packages/core` | 共享契约及行为 |
| `packages/chat-ui`、`packages/ui-web`、`packages/ui-tokens` | 共用渲染、组件和主题 |
| `docs/v2/README.md` | 2.0 架构、体验和验收文档 |
| `feature_list.json`、`progress.txt` | 验收要求及追加式开发记录 |
| `local/README.md` | 本机交付、运行依赖、历史证据与恢复清单 |

源码、测试、数据库迁移和尚未提交的修改保留在原位。历史交接只说明当时状态，
与当前实现冲突时以最新用户要求及已经验证的实现为准。

## 环境与命令

版本要求以根目录 `package.json` 为准，使用其固定的 pnpm 版本。

```sh
pnpm install --frozen-lockfile
node --test packages/workbench/src/*.test.ts
node --test packages/kernel-runtime/src/*.test.ts
pnpm exec tsc --noEmit -p packages/workbench/tsconfig.json
pnpm exec vitest run apps/web/src
```

继承的服务端独立开发时使用下列命令；不把它们作为 2.0 桌面的启动步骤：

```sh
pnpm db:generate
pnpm --filter @livingbot/api check
pnpm --filter @livingbot/worker check
pnpm --filter @livingbot/web check
pnpm --filter @livingbot/adapters check
```

从 `.env.example` 配置本机环境。生产配置、密钥、数据库、附件和运行日志不得进入 Git。
2.0 桌面的连接通过应用设置配置，架构及打包方式见 [桌面文档](v2/desktop.md)。

## 代码与资料

公共设计说明和开发文档放在 `docs/`；测试与对应实现同目录。个人审查证据、实施计划、截图和候选构建放在被忽略的 `local/`，不要把其中的真实用户资料复制进公共文档。

保留当前有效交付、回滚版本及必要证据。清理本机产物使用 macOS 废纸篓，不永久删除用户文件；构建验证输出放入独立目录，避免覆盖正在运行的服务产物。

## 验证边界

单元测试默认离线。需要真实模型、数据库或桌面交互的测试必须按其专门流程运行。桌面端到端测试会抢占窗口焦点，不作为本机例行检查。调用构建或测试脚本前，先检查清理逻辑。

本地检查不能替代实际运行验收；报告中应区分类型检查、模拟测试、构建检查和正式环境验证。

`apps/www/` 保留了继承的网站模板，发布前需单独核对商业与托管服务文案；不属于当前自托管服务的自动部署入口。
