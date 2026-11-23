#!/usr/bin/env node
/** Optional local editor adapter. Loaded only as an explicitly configured MCP program. */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { LocalOfficeFiles } from "./local-office-files.mjs";

const option = (key) => { const i = process.argv.indexOf(`--${key}`); if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing --${key}`); return resolve(process.argv[i + 1]); };
const sheetIndex = process.argv.indexOf("--sheet-package");
const sheetPackage = sheetIndex < 0 ? undefined : resolve(process.argv[sheetIndex + 1]);
const enginePackage = option("engine-package"), root = await realpath(option("root"));
const stateRoot = option("state"), dependencies = option("dependencies");
if (process.platform !== "darwin") throw new Error("This editor adapter requires a verified macOS sandbox profile");
await mkdir(stateRoot, { recursive: true, mode: 0o700 });
const state = await mkdtemp(join(stateRoot, "session-"));
const files = new LocalOfficeFiles(root, state);
const require = createRequire(dependencies);
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { TencentDocsService } = createRequire(import.meta.url)(join(enginePackage, "lib/common/tencent-docs-service.js"));
const token = randomBytes(32).toString("base64url");
const log = (...args) => { process.stderr.write(args.join(" ") + "\n"); };
const portProbe = createServer();
await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
const port = portProbe.address().port; await new Promise((done) => portProbe.close(done));
// Block deletion syscalls, rather than rename's shared file-write-unlink permission.
// The latter would also prevent safe atomic saves. No deletion is performed by this process.
const reads = [state, root, enginePackage, "/System", "/usr", "/Library/Fonts", "/private/etc", "/private/var/db", "/private/preboot", "/Library/Apple", "/dev"].map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
const profile = `(version 1)\n(allow default)\n(deny file-read-data (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp"))\n(allow file-read-data ${reads})\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(state)}) (literal "/dev/null"))\n(deny syscall-unix (with errno 2) (syscall-number SYS_unlink) (syscall-number SYS_unlinkat) (syscall-number SYS_rmdir))\n(deny network-outbound)\n`;
const profilePath = join(state, "engine.sb"); await writeFile(profilePath, profile, { mode: 0o600 });
const engine = new TencentDocsService({
  port: String(port), editorSdkPath: join(enginePackage, "bin/darwin-arm64/editor_sdk"), logDir: state,
  corsOrigins: [], logger: { info: log, warn: log, error: log, debug() {} },
  editorSdkProcessLauncher: { launch(request) {
    const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, request.binaryPath, ...request.args], {
      cwd: state, env: { ...process.env, TMPDIR: state }, stdio: ["ignore", "pipe", "pipe"],
    });
    return Object.assign(child, { requestStop: () => child.kill("SIGTERM"), forceStop: () => child.kill("SIGKILL") });
  } },
});
let tools, stopping;
const aliases = new Map();
let sheetClient, sheetTransport, sheetStarting, sheetTools;
const sheetSerial = new Map();
const serial = new Map();
const supported = (name) => !name.endsWith("_get_selection") && (/^(doc_|sheet_)/.test(name) || ["create_doc", "create_sheet", "open_file", "save_file", "close_file", "find", "get_pool_status"].includes(name));
async function rpc(method, params) {
  await engine.ensureStarted();
  const response = await fetch(`http://127.0.0.1:${engine.getPort?.() ?? port}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(120_000),
  });
  const value = await response.json();
  if (!response.ok || value.error || value.result?.isError) throw new Error(value.error?.message ?? JSON.stringify(value.result));
  return value.result;
}
async function schemas(includeSheet = false) {
  tools ??= (await rpc("tools/list", {})).tools.filter((tool) => supported(tool.name));
  if (includeSheet && sheetPackage) { await startSheet(); return [...tools, ...sheetTools]; }
  return tools;
}
function remember(result) {
  for (const key of ["file_id", "file_path"]) if (result[key]) files.own(result[key]);
}
async function invoke(name, input) {
  const schema = (await schemas()).find((tool) => tool.name === name);
  if (!schema) throw new Error("Tool is outside the configured document/spreadsheet capability");
  const args = { ...input };
  if (aliases.has(args.file_id)) args.file_id = aliases.get(args.file_id);
  if (["create_doc", "create_sheet"].includes(name)) {
    const result = await rpc("tools/call", { name, arguments: {} }); remember(result); return result;
  }
  if (name === "open_file") {
    const requested = args.file_path;
    args.file_path = files.opened.has(args.file_path) ? args.file_path : await files.input(args.file_path);
    const inspected = await promisify(execFile)("python3", [fileURLToPath(new URL("./local-office-inspect.py", import.meta.url)), args.file_path], { timeout: 30_000 });
    const features = JSON.parse(inspected.stdout);
    if (Object.values(features).some(Boolean)) throw new Error("This file contains macros, external workbook links or embedded objects; this editing round trip is not verified to preserve them");
    args.wait = true; args.allow_shared = false;
    const result = await rpc("tools/call", { name, arguments: args });
    files.own(args.file_path); aliases.set(requested, args.file_path); remember(result);
    return { ...result, file_id: result.file_id ?? args.file_path, source_preserved: true };
  }
  if (name === "get_pool_status") {
    const result = await rpc("tools/call", {name,arguments:{}});
    for (const block of result.content ?? []) if (block.type === "text") {
      try {
        const value = JSON.parse(block.text);
        if (Array.isArray(value.open_editors)) {
          value.open_editors = value.open_editors.filter((editor)=>files.opened.has(editor.file_id)).map((editor)=> {
            const original = [...aliases].find(([,copy])=>copy === editor.file_id)?.[0];
            return original ? {...editor,file_id:original,file_path:original} : editor;
          });
          block.text = JSON.stringify(value);
        }
      } catch { /* Non-JSON tool text is retained without inferring its meaning. */ }
    }
    return result;
  }
  files.assertEditor(args.file_id);
  if (name === "save_file") {
    if (!args.file_path) {
      const directory = await mkdtemp(join(state,"autosave-"));
      const snapshot = join(directory,"snapshot" + (String(args.file_id).endsWith(".docx") ? ".docx" : ".xlsx"));
      const result = await rpc("tools/call", {name,arguments:{...args,file_path:snapshot}});
      return {...result,file_path:snapshot,delivery:false};
    }
    const { staged, target } = await files.output(args.file_path);
    const result = await rpc("tools/call", { name, arguments: { ...args, file_path: staged } });
    await files.publish(staged, target);
    return { ...result, file_path: target, source_preserved: true,
      content: [{ type: "text", text: JSON.stringify({ file_path: target, source_preserved: true }) }] };
  }
  return rpc("tools/call", { name, arguments: args });
}
async function call(name, args) {
  if (name.startsWith("sheetagent.")) {
    const key = aliases.get(args.file_id ?? args.file) ?? args.file_id ?? args.file;
    const next = (sheetSerial.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await startSheet(); return sheetClient.callTool({name:name.slice("sheetagent.".length),arguments:args});
    });
    if (key) sheetSerial.set(key,next);
    try { return await next; } finally { if (sheetSerial.get(key) === next) sheetSerial.delete(key); }
  }
  const key = aliases.get(args.file_id) ?? args.file_id;
  const previous = key ? serial.get(key) : undefined;
  const next = (previous ?? Promise.resolve()).catch(() => {}).then(() => invoke(name, args));
  if (key) serial.set(key, next);
  try { return await next; } finally { if (serial.get(key) === next) serial.delete(key); }
}
const endpoint = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error("Request too large"); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result;
    if (request.url === "/mcp") {
      if (body.method === "tools/list") result = { tools: await schemas() };
      else if (body.method === "tools/call") result = await call(body.params.name, body.params.arguments ?? {});
      else if (body.method === "initialize") result = {protocolVersion:body.params?.protocolVersion ?? "2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"local-office-upstream",version:"1.0.0"}};
      else if (body.method?.startsWith("notifications/")) { response.writeHead(202).end(); return; }
      else if (body.method === "ping") result = {};
      else throw new Error("Unsupported editor request");
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } else if (request.url === "/localapi/sheet/check_formula") {
      const source = await files.input(body.src_path), output = await files.output(body.dst_path, true);
      await engine.ensureStarted();
      const checked = await fetch(`http://127.0.0.1:${engine.getPort?.() ?? port}/localapi/sheet/check_formula`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ src_path: source, dst_path: output.staged }), signal: AbortSignal.timeout(120_000),
      }).then((r) => r.json());
      if (checked.code === 0) await files.publish(output.staged, output.target);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(checked));
    } else throw new Error("Unsupported editor endpoint");
  } catch (error) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: error.message } })); }
});
await new Promise((done) => endpoint.listen(0, "127.0.0.1", done));
const connectionPath = join(state, "connection.json");
await writeFile(connectionPath, JSON.stringify({ url: `http://127.0.0.1:${endpoint.address().port}/mcp`, token, pid: process.pid, root }), { mode: 0o600 });
async function startSheet() {
  if (!sheetPackage) throw new Error("Spreadsheet execution adapter is not configured");
  if (sheetStarting) return sheetStarting;
  sheetStarting = (async () => {
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
    const sheetProfile = profile.replace("(deny network-outbound)", `(deny network-outbound)\n(allow network-outbound (remote ip "localhost:${endpoint.address().port}"))`)
      + `\n(allow file-read-data (subpath ${JSON.stringify(sheetPackage)}) (literal ${JSON.stringify(process.execPath)}))\n`;
    const sheetProfilePath = join(state,"sheet.sb"); await writeFile(sheetProfilePath,sheetProfile,{mode:0o600});
    sheetTransport = new StdioClientTransport({command:"/usr/bin/sandbox-exec",args:["-f",sheetProfilePath,process.execPath,join(sheetPackage,"server.mjs")],cwd:state,
      env:{...process.env, LIVINGBOT_OFFICE_CONNECTION:connectionPath, SHEET_API_MODE:"local", SHEETAGENT_MCP_TRANSPORT:"stdio", SHEETAGENT_LOG_FILE:join(state,"sheetagent.log"), TMPDIR:state},stderr:"pipe"});
    sheetTransport.stderr?.on("data",(bytes)=>process.stderr.write(bytes));
    sheetClient = new Client({name:"local-office-sheet",version:"1.0.0"},{capabilities:{}});
    await sheetClient.connect(sheetTransport);
    sheetTools = (await sheetClient.listTools()).tools.map((tool)=>({...tool,name:"sheetagent."+tool.name}));
  })(); return sheetStarting;
}
const server = new Server({ name: "local-office", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "office_schema", description: "Read the exact schema of one local document or spreadsheet tool before calling it. Omit name to list tool names. Returns the managed connection file for compatible local scripts.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "office_call", description: "Call a local editor tool using its exact schema. Inputs are copied; save_file requires a new output under workspace tasks/ or projects/. Use livingbot_deliver_file to deliver the exported file.", inputSchema: { type: "object", required: ["name", "arguments"], properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } } } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments ?? {};
    const result = request.params.name === "office_schema"
      ? { connection_file: connectionPath, tools: args.name ? (await schemas(args.name?.startsWith("sheetagent."))).filter((tool) => tool.name === args.name) : (await schemas(true)).map((tool) => ({ name: tool.name, title: tool.title })) }
      : request.params.name === "office_call" ? await call(args.name, args.arguments ?? {}) : (() => { throw new Error("Unknown office tool"); })();
    return { ...(result?.isError ? {isError:true} : {}), content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: "text", text: error.message }] }; }
});
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => { await sheetClient?.close(); await engine.dispose(); endpoint.closeAllConnections(); await new Promise((done) => endpoint.close(done)); await server.close();
    const trash = await mkdtemp(join(userInfo().homedir, ".Trash/LivingBot-office-session-"));
    await rename(state, join(trash, "session"));
    const receipt = { original: state, recovery: join(trash, "session") };
    await writeFile(join(trash, "recovery.json"), JSON.stringify(receipt), { mode: 0o600 });
    await appendFile(join(stateRoot, "recovery.jsonl"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
    log("editor session retained", JSON.stringify(receipt));
  })(); return stopping;
}
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
process.stdin.once("end", () => void stop());
await server.connect(new StdioServerTransport());
