# 开发指南

## 环境与命令

版本要求以根目录 `package.json` 为准，使用其固定的 pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @livingbot/api check
pnpm --filter @livingbot/worker check
pnpm --filter @livingbot/web check
pnpm --filter @livingbot/adapters check
```

从 `.env.example` 配置本机环境。生产配置、密钥、数据库、附件和运行日志不得进入 Git。

## 代码与资料

公共设计说明和开发文档放在 `docs/`；测试与对应实现同目录。个人审查证据、实施计划、截图和候选构建放在被忽略的 `local/`，不要把其中的真实用户资料复制进公共文档。

保留当前有效交付、回滚版本及必要证据。清理本机产物使用 macOS 废纸篓，不永久删除用户文件；构建验证输出放入独立目录，避免覆盖正在运行的服务产物。

## 验证边界

单元测试默认离线。需要真实模型、数据库或桌面交互的测试必须按其专门流程运行。桌面端到端测试会抢占窗口焦点，不作为本机例行检查。调用构建或测试脚本前，先检查清理逻辑。

本地检查不能替代实际运行验收；报告中应区分类型检查、模拟测试、构建检查和正式环境验证。

`apps/www/` 保留了继承的网站模板，发布前需单独核对商业与托管服务文案；不属于当前自托管服务的自动部署入口。
