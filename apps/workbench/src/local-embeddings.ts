import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A local embedding runtime placed inside this application's own state directory.
 * Nothing here points at a developer machine: the server and the model live under
 * `<state>/tools/llama.cpp/...` and `<state>/models/llama.cpp/...`, so the whole
 * directory can be moved or copied.
 */
export type LocalEmbeddingService = {
  provider: "llama-cpp";
  /** Where the official assets came from: this app's bundle, or a populated state dir. */
  source: "bundled" | "state";
  model: string;
  baseUrl: string;
  healthUrl: string;
  command: string;
  args: string[];
  preset: string;
};

const MODEL_ROOT = ["models", "llama.cpp"];
const TOOL_ROOT = ["tools", "llama.cpp"];

/** The id both the preset and `memory.search.model` must agree on. */
export function embeddingModelId(filename: string): string {
  return filename.replace(/\.gguf$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.R_OK | constants.X_OK).then(() => true, () => false);
}

/** Official llama-server layout: <tools>/<release>/<platform>-<arch>/llama-server. */
async function findServer(base: string): Promise<string | undefined> {
  const tools = join(base, ...TOOL_ROOT);
  const releases = await readdir(tools, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const release of releases.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const platform = await readdir(join(tools, release), { withFileTypes: true }).catch(() => []);
    for (const entry of platform.filter((item) => item.isDirectory())) {
      const path = join(tools, release, entry.name, "llama-server");
      if (await exists(path)) candidates.push(path);
    }
  }
  return candidates.at(-1);
}

/** Exactly one embedding model, so the choice is never guessed. */
async function findModel(base: string): Promise<string | undefined> {
  const root = join(base, ...MODEL_ROOT);
  const files = await readdir(root).catch(() => [] as string[]);
  const models = files.filter((name) => /\.gguf$/i.test(name)).sort();
  return models.length === 1 ? join(root, models[0]!) : undefined;
}

/**
 * Returns the service only when this installation actually carries the official
 * runtime and one embedding model. Otherwise the product keeps its real
 * text-only behaviour instead of pretending to be semantic.
 */
export async function discoverLocalEmbeddings(
  state: string, port: number, options: { bundledRoot?: string } = {},
): Promise<LocalEmbeddingService | undefined> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid embedding port");
  // An operator's own copies win; otherwise the assets shipped with this app are used.
  let source: "bundled" | "state" = "state";
  let command = await findServer(state);
  let model = await findModel(state);
  if ((!command || !model) && options.bundledRoot) {
    const bundledCommand = await findServer(options.bundledRoot);
    const bundledModel = await findModel(options.bundledRoot);
    if (bundledCommand && bundledModel) {
      command = bundledCommand; model = bundledModel; source = "bundled";
    }
  }
  if (!command || !model) return undefined;
  const id = embeddingModelId(model.split("/").pop()!);
  const preset = join(state, ...TOOL_ROOT, "models.ini");
  await mkdir(join(state, ...TOOL_ROOT), { recursive: true, mode: 0o700 });
  // The same preset shape the official setup writes, with relocatable paths.
  const ini = [
    "version = 1",
    "",
    `[${id}]`,
    `model = ${model}`,
    "embedding = true",
    "parallel = 1",
    "ctx-size = 2048",
    "ubatch-size = 2048",
    "",
  ].join("\n");
  await writeFile(preset, ini, { mode: 0o600 });
  return {
    provider: "llama-cpp",
    source,
    model: id,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    command,
    args: ["--host", "127.0.0.1", "--port", String(port), "--models-preset", preset,
      "--models-max", "2", "--metrics", "--no-ui"],
    preset,
  };
}

/**
 * The kernel stamps the *first* index pass with whatever provider is ready then,
 * and it has no rebuild action, so the managed server must answer /health before
 * the kernel starts indexing. If it never becomes ready the caller wires nothing.
 */
export async function warmLocalEmbeddings(
  service: LocalEmbeddingService, timeoutMs = 30_000,
): Promise<{ child?: ChildProcess; ready: boolean }> {
  const running = await healthy(service.healthUrl);
  if (running) return { ready: true };
  const child = spawn(service.command, service.args, { stdio: "ignore" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { child, ready: false };
    if (await healthy(service.healthUrl)) return { child, ready: true };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { child, ready: false };
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

/** Only the child this process started is stopped; a pre-existing service is left alone. */
export function stopLocalEmbeddings(service: { child?: ChildProcess } | undefined): void {
  if (service?.child && service.child.exitCode === null) service.child.kill("SIGTERM");
}

/** True when this installation can serve embeddings, without touching the network. */
export async function localEmbeddingsPresent(state: string, bundledRoot?: string): Promise<boolean> {
  const base = (await findServer(state)) ? state : bundledRoot ?? state;
  const tool = join(base, ...TOOL_ROOT);
  const models = join(base, ...MODEL_ROOT);
  const release = await readdir(tool, { withFileTypes: true }).catch(() => []);
  const files = await readdir(models).catch(() => [] as string[]);
  if (!release.some((entry) => entry.isDirectory()) || !files.some((name) => /\.gguf$/i.test(name))) return false;
  return Boolean(await findServer(base));
}
