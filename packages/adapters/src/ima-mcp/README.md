# IMA MCP adapter

腾讯 IMA 知识库的 MCP 适配器：把 IMA 的 OpenAPI 包装成 stdio MCP 服务，供 2.0 能力中心作为「应用连接」使用。

1.0 里这是一个 OpenAPI 导入的连接器；2.0 的连接只认 MCP，所以形态改成适配器进程。工具名和参数与 1.0 保持一致，模型不需要重新学。

## 工具

只读（与 1.0 相同）：

| 工具 | 作用 |
| --- | --- |
| `ima_search_knowledge_base` | 按名字找知识库，query 传空列全部 |
| `ima_get_knowledge_base` | 知识库详情（最多 20 个 id） |
| `ima_list_knowledge` | 浏览知识库里的文件与文件夹 |
| `ima_search_knowledge` | 在单个知识库里按关键词检索 |
| `ima_search_notes` | 检索笔记（标题 / 正文） |
| `ima_list_note_folders` | 列出笔记本 |
| `ima_list_notes` | 列出某个笔记本下的笔记 |
| `ima_get_note_content` | 读取笔记正文 |
| `ima_list_addable_knowledge_bases` | 列出有写入权限的知识库 |
| `ima_get_media_info` | 取条目的原文访问链接 |

写入（1.0 没做的部分）：

| 工具 | 作用 |
| --- | --- |
| `ima_check_repeated_names` | 上传前查同名文件 |
| `ima_upload_knowledge_file` | 本机文件 → 知识库（申请凭证 → COS 上传 → 登记入库） |
| `ima_import_urls` | 网页 / 公众号文章入知识库（1-10 条） |
| `ima_add_note_to_knowledge` | 把 IMA 笔记加进知识库 |

上传在本地先判类型和大小：Excel / TXT / Markdown / Xmind 10 MB，图片 30 MB，其余 200 MB；不支持的类型（如视频）不会发出任何请求。同名文件默认停下等用户确认，`overwrite: true` 才继续。

## 凭证

Client ID 与 API Key 在 <https://ima.qq.com/agent-interface> 生成。读取顺序：

1. 连接配置里的 `IMA_CLIENT_ID` / `IMA_API_KEY` 环境变量；
2. `~/.config/ima/client_id` 与 `~/.config/ima/api_key`。

凭证只在适配器进程里用作请求头，不进入工具参数、模型上下文或日志。

## 运行

Node 22.18+（直接执行 TypeScript，无需构建）：

```sh
node packages/adapters/src/ima-mcp/main.ts
```

在 2.0 里注册：能力页「添加能力」→ 连接方式「本机程序」，程序命令填 node 的绝对路径，参数填上面这个文件路径。

## 测试

```sh
npx vitest run packages/adapters/src/ima-mcp/mcp.test.ts
```

全部离线：工具清单、协议往返、错误透传、上传四步顺序、查重与覆盖、类型与大小规则、COS 签名（与 IMA 官方脚本的输出逐个字符对齐）。

## 边界

- IMA 的 MCP 端点（`https://ima.qq.com/mcp`）只认 IMA 的 access token，不认 Client ID + API Key，也没有 OAuth 元数据，所以不能像普通远程连接那样直接接过去。
- 没有做笔记的新建与追加：官方文档没给出 `import_doc` / `append_doc` 的参数，照猜会写错。
- 视频网页（Bilibili、YouTube）和本地 HTML 只能由 IMA 客户端添加。
