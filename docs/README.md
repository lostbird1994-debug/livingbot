# LivingBot 文档

此工作区为 2.0。当前架构与验收入口见 [2.0 文档](v2/README.md)；其余文档继承自 1.0，涉及旧服务栈的说明需结合 2.0 文档使用。

[项目说明](../README.md) · [贡献指南](../CONTRIBUTING.md) · [安全报告](../SECURITY.md)

## 开始使用

- [Getting started](getting-started.md)
- [Bots and chats](bots-and-chats.md)
- [Models](models.md)
- [Voice and calls](voice-and-calls.md)
- [Realtime voice](realtime-voice.md)
- [Routines](routines.md)
- [Approvals](approvals.md)
- [Settings from chat, product help, and lazy tool loading](settings-from-chat-tasks.md)
- [Groups and teamwork](groups.md)
- [Spaces](spaces.md)
- [Account and billing](account.md)
- [Reusable credentials](bot-secrets.md)
- [Skills](skills.md)
- [Connect apps](integrations.md)
- [Chat apps](messaging-apps.md)
- [Import an OpenClaw, Hermes or ChatGPT agent](import-an-agent.md)
- [Tool activity](tool-activity.md)
- [Inline explanations](inline-visuals.md)
- [Memory](memory.md)
- [The bot's computer](computer.md)

## 开发与发布

- [开发指南](development.md)
- [命名与兼容约定](compatibility.md)
- [Run dispatch and response timing](run-execution.md)
- [Computer runtime](computer-runtime.md)
- [Agent verification](agent-verification.md)
- [Build a plugin](build-a-plugin.md)
- [Desktop app](desktop-app.md)
- [Desktop releases](desktop-release.md)
- [Mobile app](mobile-app.md)
- [Mobile builds and store releases](mobile-release.md)
- [Desktop performance benchmarks](performance.md)
- [Content encryption at rest](content-encryption.md)
- [自托管数据与隐私说明](privacy.md)
- [OpenClaw 运行时升级备忘](openclaw-upgrade.md)

## 自托管

- [Self-hosting LivingBot](self-host.md)
- [Configuration](self-host-configuration.md)
- [Models](self-host-models.md)
- [Sign-in and accounts](self-host-accounts.md)
- [Apps and clients](self-host-clients.md)
- [Storage and encryption](self-host-storage.md)
- [Self-host secrets checklist](self-host-secrets.md)
- [Backup and restore](self-host-backups.md)
- [Upgrading](self-host-upgrading.md)
- [Production deployment](self-host-production.md)
- [Logs and monitoring](self-host-observability.md)
- [Audit log](self-host-audit-log.md)
- [Billing](self-host-billing.md)
- [Tools and integrations](self-host-integrations.md)
- [Self-host sandbox / computer providers](self-host-sandbox-providers.md)
- [Docker computers](self-host-docker-computers.md)
- [Self-hosting on restricted networks](self-host-restricted-network.md)
- [Manage the bots it creates](fleet-management.md)
- [Optional Infisical secret storage](infisical-secrets.md)

## 设计、评审与历史

- [项目起源与发展](project-history.md)
- [Memory roadmap](memory-roadmap.md)
- [Memory review follow-ups](memory-review-followups.md)
- [Mobile AI data sharing: release and review](ai-data-sharing-review.md)
- [Conversation context and model eval tasks](context-and-evals-tasks.md)

## 验收与上游资料

- [历史检索离线评估](evals/history-retrieval-offline.md)
- [历史检索发现](evals/history-findings.md)
- [上游来源说明](reference/upstream.md)

`reference/` 为继承的历史参考，不作为当前发布与自动更新策略。

本机计划、交付记录、审查证据和清理恢复清单位于被 Git 忽略的 `local/`；从其中的 `README.md` 与 `文档索引.md` 查找。
