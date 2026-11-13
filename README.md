# LivingBot

LivingBot 是面向个人工作流的自托管 Bot 工作台，支持持久 Bot、独立任务会话、文件与聊天历史，以及 OpenClaw 执行接入。

## 项目起源与发展

本项目由 [Rakazo](https://github.com/elie222/rakazo) 发展而来，保留其开源基础和原始许可，在此基础上持续适配个人使用场景。项目沿革、继承关系和兼容约定见[项目历史](docs/project-history.md)。

## 当前重点

- 同一 Bot 的独立任务会话与并行执行。
- 每轮独立原生会话，以及由应用维护的历史摘要和上下文衔接。
- 可见、可重试的任务停止与恢复状态。
- 文件引用、附件、例行任务及结果展示。
- 独立版本管理；上游更新不自动覆盖本项目。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
```

Node.js 版本与 pnpm 版本以 [package.json](package.json) 为准。复制 `.env.example` 后按需配置模型和运行环境，不要提交凭据或运行数据。

## 目录

| 目录 | 内容 |
| --- | --- |
| `apps/` | API、后台任务、Web、桌面、移动端与网站 |
| `packages/` | 共享协议、核心逻辑、数据层、运行适配和 UI |
| `scripts/` | 开发、构建与维护工具 |
| `infra/` | 部署与计算环境配置 |
| `docs/` | 架构、开发和功能文档 |
| `local/` | 本机审查、计划和构建验证；不提交 |

参阅[文档索引](docs/README.md)、[开发指南](docs/development.md)和[兼容约定](docs/compatibility.md)。历史上游文档与下载链接仅供参考，不代表本项目发布渠道。

## 许可

保留原始 Apache-2.0 许可及上游署名，见 [LICENSE](LICENSE)。
