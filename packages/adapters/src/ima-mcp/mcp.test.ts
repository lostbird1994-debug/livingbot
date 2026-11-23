import { describe, expect, it, vi } from "vitest";
import { cosAuthorization } from "./cos.ts";
import { createImaClient, ImaError } from "./ima-client.ts";
import { createImaMcpHandler } from "./mcp.ts";
import { planUpload } from "./media.ts";
import { callTool, type ToolContext } from "./tools.ts";

const credentials = { clientId: "client", apiKey: "key" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function handlerWith(fetchImpl: typeof fetch) {
  return createImaMcpHandler({ credentials, fetchImpl });
}

async function toolNames(): Promise<string[]> {
  const response = await createImaMcpHandler({ credentials })({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const result = response?.result as { tools?: { name: string }[] } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name);
}

describe("MCP surface", () => {
  it("advertises the same read tools LivingBot 1.0 installed", async () => {
    const tools = await toolNames();
    expect(tools).toEqual(
      expect.arrayContaining([
        "ima_search_knowledge_base",
        "ima_get_knowledge_base",
        "ima_list_knowledge",
        "ima_search_knowledge",
        "ima_search_notes",
        "ima_list_note_folders",
        "ima_list_notes",
        "ima_get_note_content",
      ]),
    );
  });

  it("offers the upload path the 1.0 connector left out", async () => {
    const names = await toolNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "ima_upload_knowledge_file",
        "ima_import_urls",
        "ima_add_note_to_knowledge",
        "ima_check_repeated_names",
        "ima_list_addable_knowledge_bases",
        "ima_get_media_info",
      ]),
    );
  });

  it("echoes the requested protocol version and declares tools", async () => {
    const handler = createImaMcpHandler({ credentials });
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(response?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "livingbot-ima" },
    });
  });

  it("answers notifications without a reply", async () => {
    const handler = createImaMcpHandler({ credentials });
    await expect(
      handler({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).resolves.toBeUndefined();
  });

  it("rejects unknown methods only when the caller expects a reply", async () => {
    const handler = createImaMcpHandler({ credentials });
    const response = await handler({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(response?.error?.code).toBe(-32601);
  });
});

describe("tool calls", () => {
  it("returns the data envelope as text", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, msg: "success", data: { info_list: [{ id: "kb1" }] } }),
    );
    const handler = handlerWith(fetchImpl as unknown as typeof fetch);
    const response = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ima_search_knowledge_base", arguments: { query: "", cursor: "", limit: 5 } },
    });
    const result = response?.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({ info_list: [{ id: "kb1" }] });
  });

  it("passes IMA's message through instead of the error code", async () => {
    const handler = handlerWith((async () =>
      jsonResponse({
        code: 200002,
        msg: "skill auth failed",
        data: {},
      })) as unknown as typeof fetch);
    const response = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ima_search_knowledge_base", arguments: { query: "", cursor: "", limit: 5 } },
    });
    const result = response?.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("skill auth failed");
    expect(result.content[0]?.text).toContain("凭证");
  });

  it("reports an unknown tool as a tool error, not a protocol error", async () => {
    const handler = createImaMcpHandler({ credentials });
    const response = await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ima_delete_everything", arguments: {} },
    });
    const result = response?.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("未知工具");
  });

  it("sends the endpoint path and body as the connector did", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: {} }));
    const client = createImaClient({
      credentials,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.call("/openapi/wiki/v1/search_knowledge", {
      query: "token",
      knowledge_base_id: "kb1",
      cursor: "",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ima.qq.com/openapi/wiki/v1/search_knowledge");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["ima-openapi-clientid"]).toBe("client");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "token",
      knowledge_base_id: "kb1",
      cursor: "",
    });
  });
});

describe("file upload", () => {
  function context(order: string[], calls: { path: string; body: Record<string, unknown> }[]) {
    const reply: Record<string, unknown> = {
      "/openapi/wiki/v1/check_repeated_names": {
        results: [{ name: "报告.pdf", is_repeated: false }],
      },
      "/openapi/wiki/v1/create_media": {
        media_id: "media-1",
        cos_credential: {
          token: "t",
          secret_id: "sid",
          secret_key: "skey",
          bucket_name: "bucket-1250000000",
          region: "ap-guangzhou",
          cos_key: "ima/2026/report.pdf",
        },
      },
      "/openapi/wiki/v1/add_knowledge": { media_id: "media-2" },
    };
    const uploadFile = vi.fn(async () => {
      order.push("upload");
    });
    const toolContext: ToolContext = {
      client: {
        async call(path, body) {
          order.push(path.split("/").pop() ?? path);
          calls.push({ path, body: body as Record<string, unknown> });
          return (reply[path] ?? {}) as Record<string, unknown>;
        },
      },
      uploadFile,
      statImpl: (async () => ({
        isFile: () => true,
        size: 1024,
        mtimeMs: 1_700_000_000_000,
      })) as never,
      readFileImpl: (async () => Buffer.from("pdf-bytes")) as never,
    };
    return { toolContext, uploadFile };
  }

  it("runs check, create, upload and add in that order", async () => {
    const order: string[] = [];
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { toolContext, uploadFile } = context(order, calls);
    const text = await callTool(toolContext, "ima_upload_knowledge_file", {
      knowledge_base_id: "kb1",
      file_path: "/tmp/报告.pdf",
    });
    expect(order).toEqual(["check_repeated_names", "create_media", "upload", "add_knowledge"]);
    expect(uploadFile).toHaveBeenCalledOnce();
    const added = calls.find((call) => call.path.endsWith("add_knowledge"))?.body;
    expect(added).toMatchObject({
      media_type: 1,
      media_id: "media-1",
      title: "报告",
      knowledge_base_id: "kb1",
      file_info: {
        cos_key: "ima/2026/report.pdf",
        file_size: 1024,
        last_modify_time: 1_700_000_000,
        password: "",
        file_name: "报告.pdf",
      },
    });
    expect(JSON.parse(text)).toMatchObject({ media_id: "media-2", title: "报告" });
  });

  it("stops before creating media when the name already exists", async () => {
    const order: string[] = [];
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { toolContext, uploadFile } = context(order, calls);
    toolContext.client = {
      async call(path) {
        order.push(path.split("/").pop() ?? path);
        if (path.endsWith("check_repeated_names")) {
          return { results: [{ name: "报告.pdf", is_repeated: true }] };
        }
        return {};
      },
    };
    await expect(
      callTool(toolContext, "ima_upload_knowledge_file", {
        knowledge_base_id: "kb1",
        file_path: "/tmp/报告.pdf",
      }),
    ).rejects.toBeInstanceOf(ImaError);
    expect(order).toEqual(["check_repeated_names"]);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("continues past a repeated name when the user asked to overwrite", async () => {
    const order: string[] = [];
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { toolContext } = context(order, calls);
    await callTool(toolContext, "ima_upload_knowledge_file", {
      knowledge_base_id: "kb1",
      file_path: "/tmp/报告.pdf",
      overwrite: true,
    });
    expect(order).toEqual(["create_media", "upload", "add_knowledge"]);
  });

  it("rejects an oversized workbook before any request", async () => {
    const order: string[] = [];
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { toolContext } = context(order, calls);
    toolContext.statImpl = (async () => ({
      isFile: () => true,
      size: 11 * 1024 * 1024,
      mtimeMs: 0,
    })) as never;
    await expect(
      callTool(toolContext, "ima_upload_knowledge_file", {
        knowledge_base_id: "kb1",
        file_path: "/tmp/表.xlsx",
      }),
    ).rejects.toThrow(/上限/u);
    expect(order).toEqual([]);
  });

  it("treats the knowledge base as the root folder when importing URLs", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const toolContext: ToolContext = {
      client: {
        async call(path, body) {
          calls.push({ path, body: body as Record<string, unknown> });
          return { results: {} };
        },
      },
    };
    await callTool(toolContext, "ima_import_urls", {
      knowledge_base_id: "kb1",
      urls: ["https://example.com/a"],
    });
    expect(calls[0]?.body).toEqual({
      knowledge_base_id: "kb1",
      folder_id: "kb1",
      urls: ["https://example.com/a"],
    });
  });
});

describe("media rules", () => {
  it("maps a PDF to media_type 1", () => {
    expect(planUpload({ fileName: "report.pdf", size: 1024 })).toEqual({
      ok: true,
      profile: { mediaType: 1, contentType: "application/pdf", fileExt: "pdf" },
    });
  });

  it("rejects files IMA cannot accept", () => {
    const plan = planUpload({ fileName: "clip.mp4", size: 1024 });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("不支持");
  });

  it("falls back to a declared content type when there is no extension", () => {
    expect(planUpload({ fileName: "download", size: 10, contentType: "application/pdf" })).toEqual({
      ok: true,
      profile: { mediaType: 1, contentType: "application/pdf", fileExt: "" },
    });
  });

  it("keeps the 10 MB ceiling for text-like files", () => {
    const plan = planUpload({ fileName: "notes.md", size: 11 * 1024 * 1024 });
    expect(plan.ok).toBe(false);
  });
});

describe("COS signature", () => {
  // Cross-checked against the signature the IMA skill script produces for the
  // same input, so the two cannot drift apart silently.
  it("matches the reference signature", () => {
    expect(
      cosAuthorization({
        secretId: "AKIDEXAMPLE",
        secretKey: "SECRETEXAMPLE",
        method: "PUT",
        pathname: "/ima/2026/report.pdf",
        headers: {
          "content-length": "1024",
          host: "bucket-1250000000.cos.ap-guangzhou.myqcloud.com",
        },
        startTime: 1_700_000_000,
        expiredTime: 1_700_003_600,
      }),
    ).toBe(
      "q-sign-algorithm=sha1&q-ak=AKIDEXAMPLE&q-sign-time=1700000000;1700003600&q-key-time=1700000000;1700003600&q-header-list=content-length;host&q-url-param-list=&q-signature=7daa5cde319c13fea3ec46a7742e914a84900dbd",
    );
  });
});
