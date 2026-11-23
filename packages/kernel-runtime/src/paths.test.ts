import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildKernelConfig } from "./config.ts";
import { preparePaths, runtimeEnvironment, runtimePaths } from "./paths.ts";

test("both Gateway and SDK use isolated credentials, temporary storage and HOME", () => {
  const paths = runtimePaths(resolve("local/synthetic-runtime"));
  const env = runtimeEnvironment(paths);
  assert.equal(env.HOME, paths.home);
  assert.equal(env.OPENCLAW_STATE_DIR, paths.state);
  assert.equal(env.OPENCLAW_CONFIG_PATH, paths.config);
  assert.equal(env.TMPDIR, paths.temporary);
  assert.equal(env.OPENCLAW_NO_RESPAWN, "1");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("preparing a root refuses lexical and symlink overlap with the previous version", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const fixture = resolve(await mkdtemp("local/test-fixtures/isolation-"));
  const protectedRoot = resolve(fixture, "previous-data");
  await mkdir(protectedRoot);
  await assert.rejects(preparePaths(runtimePaths(resolve(protectedRoot, "nested")), [protectedRoot]), /overlaps/);
  const link = resolve(fixture, "new-link");
  await symlink(protectedRoot, link);
  await assert.rejects(preparePaths(runtimePaths(link), [protectedRoot]), /protected/);
});

test("native agent configuration preserves distinct identities and same-agent private recall", () => {
  const paths = runtimePaths(resolve("local/synthetic-runtime"));
  const config = buildKernelConfig(paths, 18888, "synthetic-token", [{ id: "example" }, { id: "second" }]);
  const agents = config.agents as { ownership: string; entries: Record<string, { memory: { search: { rememberAcrossConversations: boolean } } }> };
  assert.equal(agents.ownership, "explicit");
  assert.equal(agents.entries.example.memory.search.rememberAcrossConversations, true);
  assert.equal(Object.keys(agents.entries).length, 2);
  assert.deepEqual(config.memory, { search: { provider: "none", store: { fts: { tokenizer: "trigram" } } } });
  assert.deepEqual(config.tools, { sessions: { visibility: "self" }, agentToAgent: { enabled: false } });
  const embedded = buildKernelConfig(paths, 18888, "token", [{ id: "example" }], {
    id: "local-model", api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "synthetic", model: "chat", embeddingModel: "embeddings", input: ["text", "image"],
  });
  assert.equal((embedded.memory as { search: { provider: string } }).search.provider, "local-model");
  assert.deepEqual((embedded.models as { providers: Record<string, { models: { input: string[] }[] }> })
    .providers["local-model"].models[0].input, ["text", "image"]);
  assert.throws(() => buildKernelConfig(paths, 18888, "token", [{ id: "../unsafe" }]), /identifier/);
  assert.throws(() => buildKernelConfig(paths, 18888, "token", [{ id: "duplicate" }, { id: "duplicate" }]), /Duplicate/);
});
