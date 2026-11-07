# LOCAL.md — 本机定制版本说明

这份仓库是 `~/Library/Application Support/Rakazo Personal/app` 的源码副本，用于给日常改动留回滚点和 diff。
不是上游发布包，也不对外发布。

## 分工

| 位置 | 是否纳入版本 | 说明 |
| --- | --- | --- |
| `app/`（本仓库） | 是 | 源码 |
| `app/node_modules`、各 `dist` | 否 | 依赖与构建产物 |
| `app/apps/*/dist-local-file-candidate` | 否 | 一次实验留下的构建产物 |
| 上级目录 `environment.json` | **否** | 含数据库连接与密码 |
| 上级目录 `local-login.json` | **否** | 含登录密码 |
| 上级目录 `database-password`、`pg-owner-password` | **否** | 数据库凭据 |
| 上级目录 `data/`、`pgdata-native/` | **否** | 真实聊天数据与数据库文件 |
| `control.cjs`、`service.cjs`、`~/Library/LaunchAgents/local.rakazo.personal.*.plist` | 否 | 部署配置，在上级目录 |

## 构建与生效

```sh
cd app/apps/web
NODE_ENV=production ./node_modules/.bin/vite build --emptyOutDir false
```

`vite preview` 直接读 `dist`，前端改完重新构建即可，无需重启服务。

后端（`api` / `worker`）改动需要重建并用 launchctl 重启：

```sh
cd app/apps/worker && node ../../scripts/build-server.mjs src/index.ts src/health-check.ts
cd app/apps/api    && node ../../scripts/build-server.mjs src/index.ts src/cli/migrate-database.ts \
  src/cli/bootstrap-owner.ts src/cli/shared-storage.ts src/cli/diagnostics.ts src/cli/wrap-env.ts
U=$(id -u)
launchctl kickstart -k "gui/$U/local.rakazo.personal.api"
launchctl kickstart -k "gui/$U/local.rakazo.personal.worker"
```

重启 api/worker 会中断正在执行的任务。重启前先确认没有在跑的运行：

```sh
psql "$DATABASE_URL" -tAc "select count(*) from runs where status in ('running','queued','pending');"
```

## 本版本相对上游的本地改动

- 会话正文排版：行高、标题字阶、块间距（`packages/chat-ui/src/markdown.web.css`）
- 回报渲染：首段结论块、依据小节折叠（`packages/chat-ui/src/rehype-report-shape.ts`）
- 会话页头部改为独立标题栏，移动端因此获得常驻顶栏（`apps/web/src/pages/shell/chat-header.tsx`）
- 设置浮层底部滚动提示、`Chat` 中文翻译、登录页品牌标记对比度
- 聊天回复的输出约定（`packages/adapters/src/run-replies.ts` 的 `REPORT_SHAPE_GUIDANCE`）

## 回滚

```sh
git log --oneline          # 找目标提交
git checkout <commit> -- . # 只回滚工作区文件
git reset --hard <commit>  # 连历史一起回退（慎用）
```

源码回退后仍需按上面的命令重新构建，改动才会在界面上生效。
