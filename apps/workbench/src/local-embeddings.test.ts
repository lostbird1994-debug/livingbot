import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";
import { runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { discoverLocalEmbeddings, embeddingModelId, localEmbeddingsPresent } from "./local-embeddings.ts";

async function state(): Promise<string> {
  return mkdtemp(join(tmpdir(), "local-embeddings-"));
}

async function placeAssets(root: string, options: { server?: boolean; model?: string } = {}): Promise<void> {
  if (options.server !== false) {
    const dir = join(root, "tools", "llama.cpp", "b10809", "darwin-arm64");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "llama-server"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "llama-server"), 0o700);
  }
  if (options.model !== undefined) {
    const dir = join(root, "models", "llama.cpp");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, options.model), "binary");
  }
}

test("an install without a runtime reports no embeddings instead of guessing", async () => {
  const empty = await state();
  assert.equal(await discoverLocalEmbeddings(empty, 43210), undefined);
  assert.equal(await localEmbeddingsPresent(empty), false);

  const serverOnly = await state();
  await placeAssets(serverOnly, {});
  assert.equal(await discoverLocalEmbeddings(serverOnly, 43210), undefined, "no model means no service");

  const modelOnly = await state();
  await placeAssets(modelOnly, { server: false, model: "a.gguf" });
  assert.equal(await discoverLocalEmbeddings(modelOnly, 43210), undefined, "no server means no service");
});

test("the service is described from this directory, never from a developer path", async () => {
  const root = await state();
  await placeAssets(root, { model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf" });
  const service = await discoverLocalEmbeddings(root, 43211);
  assert.ok(service, "assets present so the service is described");
  assert.equal(service.provider, "llama-cpp");
  assert.equal(service.command, join(root, "tools/llama.cpp/b10809/darwin-arm64/llama-server"));
  assert.equal(service.baseUrl, "http://127.0.0.1:43211/v1");
  assert.equal(service.healthUrl, "http://127.0.0.1:43211/health");
  assert.deepEqual(service.args.slice(0, 4), ["--host", "127.0.0.1", "--port", "43211"]);
  const preset = await readFile(service.preset, "utf8");
  assert.match(preset, new RegExp(`\\[${service.model}\\]`));
  assert.match(preset, new RegExp(join(root, "models/llama.cpp").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(preset.includes("/Users/"), false, "no absolute developer path is written");
});

test("two models are ambiguous, so the product stays text-only", async () => {
  const root = await state();
  await placeAssets(root, { model: "one.gguf" });
  await placeAssets(root, { server: false, model: "two.gguf" });
  assert.equal(await discoverLocalEmbeddings(root, 43212), undefined);
});

test("model ids are stable and match between preset and memory.search", () => {
  assert.equal(embeddingModelId("hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf"), "hf_ggml-org_embeddinggemma-300m-qat-q8_0");
  assert.equal(embeddingModelId("Embedding.GGUF"), "embedding");
});

test("without embeddings the kernel config keeps its text-only shape", async () => {
  const paths = runtimePaths(await state());
  const plain = buildKernelConfig(paths, 41000, "token", [{ id: "living" }]);
  assert.equal((plain.memory as { search: { provider: string } }).search.provider, "none");
  assert.equal(plain.models, undefined, "no provider block is invented");
  const wired = buildKernelConfig(paths, 41000, "token", [{ id: "living" }], undefined, {
    provider: "llama-cpp", model: "m1", baseUrl: "http://127.0.0.1:41001/v1",
    command: "/state/tools/llama.cpp/b10809/darwin-arm64/llama-server", args: ["--port", "41001"],
    healthUrl: "http://127.0.0.1:41001/health",
  });
  const memory = (wired.memory as { search: { provider: string; model?: string } }).search;
  assert.equal(memory.provider, "llama-cpp");
  assert.equal(memory.model, "m1");
  const providers = (wired.models as { providers: Record<string, { localService: { command: string } }> }).providers;
  assert.equal(providers["llama-cpp"]!.localService.command, "/state/tools/llama.cpp/b10809/darwin-arm64/llama-server");
});

test("assets shipped with the application are used when the state directory is empty", async () => {
  const bundled = await state();
  await placeAssets(bundled, { model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf" });
  const empty = await state();
  const service = await discoverLocalEmbeddings(empty, 43213, { bundledRoot: bundled });
  assert.ok(service, "the bundle is enough for an ordinary installation");
  assert.equal(service.source, "bundled");
  assert.equal(service.command, join(bundled, "tools/llama.cpp/b10809/darwin-arm64/llama-server"));
  // The preset still lives in the writable state directory.
  assert.equal(service.preset, join(empty, "tools/llama.cpp/models.ini"));
});

test("an operator's own copies win over the bundle", async () => {
  const bundled = await state();
  await placeAssets(bundled, { model: "hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf" });
  const own = await state();
  await placeAssets(own, { model: "custom.gguf" });
  const service = await discoverLocalEmbeddings(own, 43214, { bundledRoot: bundled });
  assert.ok(service);
  assert.equal(service.source, "state");
  assert.equal(service.model, "custom");
  assert.equal(service.command, join(own, "tools/llama.cpp/b10809/darwin-arm64/llama-server"));
});

test("no bundle and no state keeps the text-only fallback", async () => {
  assert.equal(await discoverLocalEmbeddings(await state(), 43215, { bundledRoot: undefined }), undefined);
});
