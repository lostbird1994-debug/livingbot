/**
 * The tool surface IMA exposes to an agent. Reads match the OpenAPI connector
 * LivingBot 1.0 installed (same names and parameters); writes cover the upload
 * path that connector deliberately left out.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { type CosCredential, uploadToCos } from "./cos.ts";
import { type ImaClient, ImaError, isRecord } from "./ima-client.ts";
import { extensionOf, planUpload } from "./media.ts";

export type ToolContext = {
  client: ImaClient;
  /** Overridable so tests can prove the three-step order without network. */
  uploadFile?: typeof uploadToCos;
  readFileImpl?: typeof readFile;
  statImpl?: typeof stat;
};

type Invoke = (context: ToolContext, args: Record<string, unknown>) => Promise<unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: Invoke;
};

const str = (title: string, description: string, optional = false) => ({
  type: "string",
  title,
  description: optional ? `${description}（可选）` : description,
});

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = text(args, key);
  return value ? value : undefined;
}

function integer(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function requireText(args: Record<string, unknown>, key: string, label: string): string {
  const value = text(args, key);
  if (!value) throw new ImaError(`缺少${label}`);
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "ima_search_knowledge_base",
    description:
      '查询用户的知识库列表。用户说出知识库名字（例如「产品文档库」）时先用本工具拿到 id，后续浏览、搜索、上传都要用这个 id。query 传空字符串表示列出全部知识库。分页：cursor 首次传 ""，limit 1-50，is_end=true 表示没有更多。',
    inputSchema: {
      type: "object",
      properties: {
        query: str("名称关键词", "知识库名称关键词；传空字符串则列出全部知识库"),
        cursor: str("游标", '游标，首次传空字符串 ""'),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "返回数量，1-50" },
      },
      required: ["query", "cursor", "limit"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/wiki/v1/search_knowledge_base", {
        query: text(args, "query"),
        cursor: text(args, "cursor"),
        limit: integer(args, "limit") ?? 20,
      });
    },
  },
  {
    name: "ima_get_knowledge_base",
    description:
      "按 id 批量获取知识库信息，最多 20 个。需要先通过 ima_search_knowledge_base 拿到 id。",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: "知识库 ID 列表，1-20 个且不重复",
        },
      },
      required: ["ids"],
    },
    async invoke({ client }, args) {
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((id): id is string => typeof id === "string")
        : [];
      if (!ids.length) throw new ImaError("缺少知识库 ID");
      return client.call("/openapi/wiki/v1/get_knowledge_base", { ids });
    },
  },
  {
    name: "ima_list_knowledge",
    description:
      "列出某个知识库指定目录下的条目。省略 folder_id 表示根目录（根目录 folder_id 等于 knowledge_base_id）。返回里同时含文件与文件夹；要看子文件夹就把它作为 folder_id 继续列。用户问「知识库里都有什么」时用这个，按关键词找具体内容用 ima_search_knowledge。",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_base_id: str("知识库 ID", "知识库 ID"),
        cursor: str("游标", '游标，首次传空字符串 ""'),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "返回数量，1-50" },
        folder_id: str("文件夹 ID", "可选，文件夹 ID；省略即根目录", false),
      },
      required: ["knowledge_base_id", "cursor", "limit"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/wiki/v1/get_knowledge_list", {
        knowledge_base_id: requireText(args, "knowledge_base_id", "知识库 ID"),
        cursor: text(args, "cursor"),
        limit: integer(args, "limit") ?? 20,
        ...(optionalText(args, "folder_id") ? { folder_id: optionalText(args, "folder_id") } : {}),
      });
    },
  },
  {
    name: "ima_search_knowledge",
    description:
      "在单个知识库内检索，返回命中的文件与文件夹，含高亮片段 highlight_content。注意检索主要命中标题：如果返回的条目 media_type 都是 99（文件夹），说明命中的是目录名，需要把 media_id 当 folder_id 用 ima_list_knowledge 下钻才能看到文件。只能检索一个知识库；用户没指明知识库时，先用 ima_search_knowledge_base 让用户选。",
    inputSchema: {
      type: "object",
      properties: {
        query: str("检索关键词", "检索关键词"),
        knowledge_base_id: str("知识库 ID", "知识库 ID"),
        cursor: str("游标", '游标，首次传空字符串 ""'),
      },
      required: ["query", "knowledge_base_id", "cursor"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/wiki/v1/search_knowledge", {
        query: requireText(args, "query", "检索关键词"),
        knowledge_base_id: requireText(args, "knowledge_base_id", "知识库 ID"),
        cursor: text(args, "cursor"),
      });
    },
  },
  {
    name: "ima_search_notes",
    description:
      "检索用户的 IMA 笔记，返回 docid，再用 ima_get_note_content 读正文。search_type 0=按标题（默认），1=按正文。start/end 为偏移分页，首次 0 到 20，is_end=true 时停止。",
    inputSchema: {
      type: "object",
      properties: {
        search_type: {
          type: "integer",
          enum: [0, 1],
          description: "0=标题检索（默认），1=正文检索",
        },
        sort_type: {
          type: "integer",
          enum: [0, 1, 2, 3],
          description: "0=更新时间（默认），1=创建时间，2=标题，3=大小",
        },
        query_info: {
          type: "object",
          description: "查询条件",
          properties: {
            title: { type: "string", description: "标题关键词" },
            content: { type: "string", description: "正文关键词" },
          },
        },
        start: { type: "integer", minimum: 0, description: "偏移起点，首屏传 0" },
        end: { type: "integer", minimum: 1, description: "偏移终点，首屏传 20" },
      },
      required: ["start", "end"],
    },
    async invoke({ client }, args) {
      const queryInfo = isRecord(args.query_info) ? args.query_info : {};
      return client.call("/openapi/note/v1/search_note_book", {
        ...(integer(args, "search_type") !== undefined
          ? { search_type: integer(args, "search_type") }
          : {}),
        ...(integer(args, "sort_type") !== undefined
          ? { sort_type: integer(args, "sort_type") }
          : {}),
        query_info: {
          ...(typeof queryInfo.title === "string" && queryInfo.title
            ? { title: queryInfo.title }
            : {}),
          ...(typeof queryInfo.content === "string" && queryInfo.content
            ? { content: queryInfo.content }
            : {}),
        },
        start: integer(args, "start") ?? 0,
        end: integer(args, "end") ?? 20,
      });
    },
  },
  {
    name: "ima_list_note_folders",
    description:
      '列出用户的笔记本，拿到 folder_id。folder_type 1 的那条是「全部笔记」根目录，其 folder_id 形如 user_list_{userid}。如果返回的空数组（用户没有自建笔记本，很常见），直接调 ima_list_notes 不带 folder_id 即可。分页：cursor 首次传 "0"，之后传 next_cursor。',
    inputSchema: {
      type: "object",
      properties: {
        cursor: str("游标", '游标，首屏传 "0"（注意与其它接口的空字符串不同）'),
        limit: { type: "integer", minimum: 1, description: "返回数量" },
      },
      required: ["cursor", "limit"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/note/v1/list_note_folder_by_cursor", {
        cursor: text(args, "cursor") || "0",
        limit: integer(args, "limit") ?? 20,
      });
    },
  },
  {
    name: "ima_list_notes",
    description:
      '按 folder_id 列出笔记；省略 folder_id 表示全部笔记，用户说「最近的笔记」但没指定分类时用这个。分页：cursor 首次传空字符串 ""，之后传 next_cursor。',
    inputSchema: {
      type: "object",
      properties: {
        folder_id: str("笔记本 ID", "可选，笔记本 ID；省略即全部笔记", false),
        cursor: str("游标", '游标，首屏传空字符串 ""'),
        limit: { type: "integer", minimum: 1, description: "返回数量" },
      },
      required: ["cursor", "limit"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/note/v1/list_note_by_folder_id", {
        ...(optionalText(args, "folder_id") ? { folder_id: optionalText(args, "folder_id") } : {}),
        cursor: text(args, "cursor"),
        limit: integer(args, "limit") ?? 20,
      });
    },
  },
  {
    name: "ima_get_note_content",
    description:
      "按 docid 读取笔记正文。target_content_format 用 0（纯文本），Markdown 格式目前不支持。需要先搜索或列出笔记拿到 docid。笔记属于用户隐私，只在用户明确要看时展示正文。",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: str("笔记 ID", "笔记唯一 ID（docid）"),
        target_content_format: {
          type: "integer",
          enum: [0, 2],
          description: "0=纯文本（推荐），2=JSON",
        },
      },
      required: ["doc_id", "target_content_format"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/note/v1/get_doc_content", {
        doc_id: requireText(args, "doc_id", "笔记 ID"),
        target_content_format: integer(args, "target_content_format") ?? 0,
      });
    },
  },
  {
    name: "ima_list_addable_knowledge_bases",
    description:
      "列出当前用户有权限写入的知识库。准备上传文件、导入网页或把笔记加进知识库时，先用它确认目标知识库；只读的知识库传进去会被服务端拒绝。分页：cursor 首次传空字符串。",
    inputSchema: {
      type: "object",
      properties: {
        cursor: str("游标", '游标，首次传空字符串 ""'),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "返回数量，1-50" },
      },
      required: ["cursor", "limit"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/wiki/v1/get_addable_knowledge_base_list", {
        cursor: text(args, "cursor"),
        limit: integer(args, "limit") ?? 20,
      });
    },
  },
  {
    name: "ima_get_media_info",
    description:
      "按 media_id 获取知识条目的原文访问信息。返回 url_info.url 时可取原文；media_type=11（笔记）时改用 notebook_id 调 ima_get_note_content。没有 url_info 说明只能在 IMA 客户端里打开。",
    inputSchema: {
      type: "object",
      properties: { media_id: str("媒体 ID", "知识条目的 media_id") },
      required: ["media_id"],
    },
    async invoke({ client }, args) {
      return client.call("/openapi/wiki/v1/get_media_info", {
        media_id: requireText(args, "media_id", "媒体 ID"),
      });
    },
  },
  {
    name: "ima_check_repeated_names",
    description:
      "上传文件前检查目标知识库（或文件夹）里是否已有同名文件。只适用于文件类型，不用于网页和笔记。返回 is_repeated=true 的条目要告诉用户，让用户决定是改名还是继续。",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_base_id: str("知识库 ID", "知识库 ID"),
        folder_id: str("文件夹 ID", "可选，文件夹 ID；省略即根目录", false),
        names: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          description: "要检查的文件名列表",
          items: {
            type: "object",
            properties: {
              name: str("文件名", "文件名（含扩展名）"),
              media_type: {
                type: "integer",
                description:
                  "媒体类型：1 PDF、3 Word、4 PPT、5 Excel、7 Markdown、9 图片、13 TXT、14 Xmind、15 录音",
              },
            },
            required: ["name", "media_type"],
          },
        },
      },
      required: ["knowledge_base_id", "names"],
    },
    async invoke({ client }, args) {
      const params = rows(args.names).map((row) => ({
        name: String(row.name ?? ""),
        media_type:
          typeof row.media_type === "number" ? row.media_type : Number(row.media_type ?? 0),
      }));
      if (!params.length) throw new ImaError("缺少要检查的文件名");
      return client.call("/openapi/wiki/v1/check_repeated_names", {
        params,
        knowledge_base_id: requireText(args, "knowledge_base_id", "知识库 ID"),
        ...(optionalText(args, "folder_id") ? { folder_id: optionalText(args, "folder_id") } : {}),
      });
    },
  },
  {
    name: "ima_import_urls",
    description:
      "把网页或微信公众号文章加进知识库，服务端自动识别类型。一次 1-10 个链接。视频网页（Bilibili、YouTube）和本地 HTML 不支持，只能在 IMA 客户端里添加。这是写操作，会真的往用户知识库写入内容。",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_base_id: str("知识库 ID", "目标知识库 ID"),
        folder_id: str("文件夹 ID", "目标文件夹 ID；根目录传知识库 ID 本身", false),
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string" },
          description: "要导入的网址，1-10 个",
        },
      },
      required: ["knowledge_base_id", "urls"],
    },
    async invoke({ client }, args) {
      const urls = Array.isArray(args.urls)
        ? args.urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
        : [];
      if (!urls.length) throw new ImaError("缺少要导入的网址");
      const knowledgeBaseId = requireText(args, "knowledge_base_id", "知识库 ID");
      return client.call("/openapi/wiki/v1/import_urls", {
        knowledge_base_id: knowledgeBaseId,
        // The endpoint requires folder_id; the root folder is the knowledge base itself.
        folder_id: optionalText(args, "folder_id") ?? knowledgeBaseId,
        urls,
      });
    },
  },
  {
    name: "ima_add_note_to_knowledge",
    description:
      "把用户的一篇 IMA 笔记加进知识库。需要先用 ima_search_notes 或 ima_list_notes 拿到 doc_id。这是写操作。",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_base_id: str("知识库 ID", "目标知识库 ID"),
        doc_id: str("笔记 ID", "笔记的 doc_id"),
        title: str("标题", "写进知识库后显示的标题"),
        folder_id: str("文件夹 ID", "可选，目标文件夹 ID；省略即根目录", false),
      },
      required: ["knowledge_base_id", "doc_id", "title"],
    },
    async invoke({ client }, args) {
      const knowledgeBaseId = requireText(args, "knowledge_base_id", "知识库 ID");
      return client.call("/openapi/wiki/v1/add_knowledge", {
        media_type: 11,
        title: requireText(args, "title", "标题"),
        knowledge_base_id: knowledgeBaseId,
        ...(optionalText(args, "folder_id") ? { folder_id: optionalText(args, "folder_id") } : {}),
        note_info: { content_id: requireText(args, "doc_id", "笔记 ID") },
      });
    },
  },
  {
    name: "ima_upload_knowledge_file",
    description:
      "把一个本机文件上传到知识库。这是三步写操作：申请上传凭证、上传文件、登记入库；失败会停下并说明停在哪一步。支持 PDF、Word、PPT、Excel、Markdown、图片、TXT、Xmind、录音；Excel/TXT/Markdown/Xmind 上限 10 MB，图片 30 MB，其余 200 MB。默认遇到同名文件会停下让用户确认；用户明确要覆盖时把 overwrite 传 true。",
    inputSchema: {
      type: "object",
      properties: {
        knowledge_base_id: str("知识库 ID", "目标知识库 ID"),
        file_path: str("文件路径", "本机文件的绝对路径"),
        folder_id: str("文件夹 ID", "可选，目标文件夹 ID；省略即根目录", false),
        title: str("标题", "可选，入库后的标题；默认用去掉扩展名的文件名", false),
        overwrite: { type: "boolean", description: "同名文件已存在时是否继续上传，默认 false" },
        content_type: str("内容类型", "可选，文件的 MIME 类型；没有扩展名时用来判断类型", false),
      },
      required: ["knowledge_base_id", "file_path"],
    },
    async invoke(context, args) {
      const knowledgeBaseId = requireText(args, "knowledge_base_id", "知识库 ID");
      const filePath = requireText(args, "file_path", "文件路径");
      const statImpl = context.statImpl ?? stat;
      const readImpl = context.readFileImpl ?? readFile;
      const info = await statImpl(filePath).catch((error: unknown) => {
        throw new ImaError(
          `读不到文件 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!info.isFile()) throw new ImaError(`${filePath} 不是文件`);
      const fileName = basename(filePath);
      const planned = planUpload({
        fileName,
        size: info.size,
        contentType: optionalText(args, "content_type"),
      });
      if (!planned.ok) throw new ImaError(planned.reason);
      const { profile } = planned;
      const folderId = optionalText(args, "folder_id");
      const title = optionalText(args, "title") || fileName.replace(/\.[^.]+$/u, "");

      if (args.overwrite !== true) {
        const checked = await context.client.call("/openapi/wiki/v1/check_repeated_names", {
          params: [{ name: fileName, media_type: profile.mediaType }],
          knowledge_base_id: knowledgeBaseId,
          ...(folderId ? { folder_id: folderId } : {}),
        });
        const repeated = rows(checked.results).find((row) => row.is_repeated === true);
        if (repeated) {
          throw new ImaError(
            `知识库里已经有同名文件「${fileName}」。需要改名后重传，或让用户确认覆盖（overwrite=true）。`,
          );
        }
      }

      const created = await context.client.call("/openapi/wiki/v1/create_media", {
        file_name: fileName,
        file_size: info.size,
        content_type: profile.contentType,
        knowledge_base_id: knowledgeBaseId,
        file_ext: profile.fileExt || extensionOf(fileName),
      });
      const mediaId = typeof created.media_id === "string" ? created.media_id : "";
      if (!mediaId) throw new ImaError("IMA 没有返回 media_id，无法继续上传");
      const credential = created.cos_credential;
      if (!isRecord(credential)) throw new ImaError("IMA 没有返回上传凭证，无法继续上传");

      const upload = context.uploadFile ?? uploadToCos;
      await upload({
        credential: credential as unknown as CosCredential,
        body: await readImpl(filePath),
        contentType: profile.contentType,
      });

      const added = await context.client.call("/openapi/wiki/v1/add_knowledge", {
        media_type: profile.mediaType,
        media_id: mediaId,
        title,
        knowledge_base_id: knowledgeBaseId,
        ...(folderId ? { folder_id: folderId } : {}),
        file_info: {
          cos_key: (credential as unknown as CosCredential).cos_key,
          file_size: info.size,
          last_modify_time: Math.floor(info.mtimeMs / 1000),
          password: "",
          file_name: fileName,
        },
      });
      return {
        media_id: typeof added.media_id === "string" ? added.media_id : mediaId,
        title,
        file_name: fileName,
        knowledge_base_id: knowledgeBaseId,
        ...(folderId ? { folder_id: folderId } : {}),
      };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export async function callTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new ImaError(`未知工具：${name}`);
  const result = await tool.invoke(context, args);
  return JSON.stringify(result ?? {}, null, 2);
}
