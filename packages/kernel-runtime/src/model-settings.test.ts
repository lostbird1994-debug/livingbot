import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRequests } from "./contracts.ts";
import { OpenClawModelSettings } from "./model-settings.ts";

function fixture(fail = false, modelInput?: ("text" | "image")[], fetcher?: typeof fetch) {
  const patches: Record<string, unknown>[] = [];
  const config: Record<string, unknown> = {
    agents: { defaults: { model: { primary: "local/example/model" } } },
    models: {
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:9000/v1",
          api: "openai-completions",
          apiKey: "synthetic-secret",
          models: [{ id: "example/model", input: modelInput }],
        },
      },
    },
  };
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: Record<string, unknown>) {
      if (method === "config.get")
        return { hash: "revision", config: structuredClone(config) } as T;
      patches.push(params);
      if (fail) throw new Error("invalid synthetic-secret");
      const patch = JSON.parse(params.raw as string);
      // Native replacePaths replaces objects too, including an explicitly empty header set.
      for (const path of params.replacePaths as string[]) {
        const keys = path.split(".");
        let target = config;
        let source = patch;
        for (const key of keys.slice(0, -1)) {
          target[key] ??= {};
          target = target[key] as Record<string, unknown>;
          source = source[key];
        }
        target[keys.at(-1)!] = source[keys.at(-1)!];
      }
      merge(config, patch);
      return {} as T;
    },
  };
  return { settings: new OpenClawModelSettings(gateway, fetcher), patches, config };
}
function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const old = target[key];
      const child =
        old && typeof old === "object" && !Array.isArray(old)
          ? (old as Record<string, unknown>)
          : {};
      target[key] = child;
      merge(child, value as Record<string, unknown>);
    } else target[key] = value;
  }
}
const input = {
  id: "local",
  model: "new-model",
  api: "openai-responses",
  baseUrl: "http://127.0.0.1:9000/v1",
};
test("model summary omits credentials and preserves model slashes", async () => {
  const { settings } = fixture();
  const value = await settings.read();
  assert.equal(value.model, "example/model");
  assert.equal(value.hasKey, true);
  assert.deepEqual(value.input, ["text"]);
  assert.ok(!JSON.stringify(value).includes("synthetic-secret"));
});
test("image input is configured explicitly and retained when an older client edits the same model", async () => {
  const { settings, patches } = fixture(false, ["text", "image"]);
  assert.deepEqual((await settings.read()).input, ["text", "image"]);
  const retained = await settings.save({ ...input, model: "example/model" });
  assert.deepEqual(retained.input, ["text", "image"]);
  assert.deepEqual(JSON.parse(patches[0].raw as string).models.providers.local.models[0].input, [
    "text",
    "image",
  ]);
  const textOnly = await settings.save({ ...input, input: ["text"] });
  assert.deepEqual(textOnly.input, ["text"]);
  assert.deepEqual(JSON.parse(patches[1].raw as string).models.providers.local.models[1].input, [
    "text",
  ]);
  const enabled = await settings.save({ ...input, input: ["text", "image"] });
  assert.deepEqual(enabled.input, ["text", "image"]);
  for (const invalid of [null, [], ["image"], ["text", "video"], ["text", "text"], "image"]) {
    await assert.rejects(settings.save({ ...input, input: invalid }), /输入类型/);
  }
  assert.equal(patches.length, 3);
});
test("saving retains a stored key and other models and uses config revision", async () => {
  const { settings, patches } = fixture();
  const saved = await settings.save(input);
  assert.equal(saved.hasKey, true);
  assert.equal(patches[0].baseHash, "revision");
  assert.deepEqual(patches[0].replacePaths, ["models.providers.local.models"]);
  const patch = JSON.parse(patches[0].raw as string);
  assert.equal(patch.agents.defaults.model.primary, "local/new-model");
  assert.equal(patch.models.providers.local.apiKey, undefined);
  assert.equal(patch.models.providers.local.models.length, 2);
  assert.equal(saved.contextWindow, 128000);
  assert.equal(saved.maxTokens, 32000);
});
test("new key reaches native config but never the returned value or error", async () => {
  const { settings, patches } = fixture();
  assert.ok(
    !JSON.stringify(await settings.save({ ...input, apiKey: "new-secret" })).includes("new-secret"),
  );
  assert.equal(JSON.parse(patches[0].raw as string).models.providers.local.apiKey, "new-secret");
  await assert.rejects(
    fixture(true).settings.save(input),
    (error: Error) => !error.message.includes("synthetic-secret"),
  );
});
test("invalid configuration never reaches native writes", async () => {
  const { settings, patches } = fixture();
  for (const change of [
    { id: "__proto__" },
    { api: "unknown" },
    { model: "" },
    { baseUrl: "file:///tmp/config" },
    { baseUrl: "https://user:secret@example.invalid" },
    { baseUrl: "https://example.invalid?apiKey=secret" },
    { apiKey: "bad\nkey" },
  ]) {
    await assert.rejects(settings.save({ ...input, ...change }));
  }
  assert.equal(patches.length, 0);
});

test("advanced settings roundtrip, omit secrets, preserve native metadata and support clearing", async () => {
  const { settings, patches, config } = fixture();
  merge(config, {
    models: {
      providers: {
        local: {
          timeoutSeconds: 90,
          headers: { "X-Old": "old-header-secret" },
          models: [
            {
              id: "example/model",
              input: ["text", "image", "audio"],
              contextWindow: 200000,
              maxTokens: 45000,
              mediaInput: { image: { maxPixels: 4000000 } },
              compat: { supportsDeveloperRole: false },
              cost: { input: 1, output: 2 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        models: {
          "local/example/model": {
            alias: "Existing",
            params: { temperature: 0.3, thinking: "low" },
          },
        },
      },
    },
  });
  const edit = { ...input, model: "example/model" };
  const advanced = await settings.save({
    ...edit,
    headers: { "X-New": "new-header-secret" },
    reasoning: true,
    thinkingLevel: "high",
    contextWindow: 256000,
    maxTokens: 64000,
  });
  assert.equal(advanced.reasoning, true);
  assert.equal(advanced.thinkingLevel, "high");
  assert.equal(advanced.contextWindow, 256000);
  assert.equal(advanced.maxTokens, 64000);
  assert.deepEqual(advanced.headerNames, ["X-New"]);
  assert.ok(!JSON.stringify(advanced).includes("header-secret"));
  const retained = await settings.save(edit);
  assert.deepEqual(retained, advanced);
  const data = config as any;
  const row = data.models.providers.local.models[0];
  assert.deepEqual(row.input, ["text", "image", "audio"]);
  assert.deepEqual(row.mediaInput, { image: { maxPixels: 4000000 } });
  assert.deepEqual(row.cost, { input: 1, output: 2 });
  assert.equal(data.models.providers.local.timeoutSeconds, 90);
  assert.deepEqual(data.agents.defaults.models["local/example/model"], {
    alias: "Existing",
    params: { temperature: 0.3, thinking: "high" },
  });
  assert.ok(!Object.hasOwn(JSON.parse(patches[1].raw as string).models.providers.local, "headers"));
  const cleared = await settings.save({
    ...edit,
    headers: {},
    thinkingLevel: null,
    reasoning: false,
    maxTokens: null,
  });
  assert.deepEqual(cleared.headerNames, []);
  assert.equal(cleared.thinkingLevel, null);
  assert.equal(cleared.reasoning, false);
  assert.equal(cleared.maxTokens, 32000);
  assert.equal(data.agents.defaults.models["local/example/model"].params.temperature, 0.3);
});

test("advanced validation and endpoint secret guards run before any native write", async () => {
  const { settings, patches, config } = fixture();
  merge(config, { models: { providers: { local: { headers: { "X-Key": "header-secret" } } } } });
  for (const change of [
    { headers: { Authorization: "secret" } },
    { headers: { "X-Key": "bad\nsecret" } },
    { headers: { "X-Key": "one", "x-key": "two" } },
    { reasoning: "true" },
    { thinkingLevel: "unknown" },
    { contextWindow: 32000, maxTokens: 32000 },
    { maxTokens: 0 },
    { contextWindow: null },
    { maxTokens: "64000" },
    { baseUrl: "https://example.invalid/v1" },
    { baseUrl: "https://example.invalid/v1", apiKey: "replacement" },
  ])
    await assert.rejects(settings.save({ ...input, ...change }));
  assert.equal(patches.length, 0);
  await settings.save({
    ...input,
    baseUrl: "https://example.invalid/v1",
    apiKey: "replacement",
    headers: {},
  });
});

test("readback mismatch cannot return an optimistic success", async () => {
  const { config } = fixture();
  const gateway: GatewayRequests = {
    async request<T>(method: string) {
      return (method === "config.get" ? { hash: "revision", config } : {}) as T;
    },
  };
  await assert.rejects(new OpenClawModelSettings(gateway).save(input), /尚未确认保存/);
});

test("declared efforts constrain settings, select a legal default, and survive reopening", async () => {
  let reads = 0;
  const { settings, patches } = fixture(false, undefined, async () => {
    reads++;
    return Response.json({
      data: [
        {
          id: "new-model",
          effort: {
            supported_levels: ["low", "high", "xhigh"],
            default_level: "high",
          },
          context_window: 256000,
          max_output_tokens: 64000,
        },
      ],
    });
  });
  const saved = await settings.save({
    ...input,
    reasoning: true,
    thinkingLevel: null,
    discover: true,
  });
  assert.equal(saved.thinkingLevel, "high");
  assert.deepEqual(saved.thinkingLevels, ["low", "high", "xhigh"]);
  assert.equal(saved.contextWindow, 128000);
  assert.equal(saved.maxTokens, 32000);
  assert.deepEqual(await settings.read(), saved);
  assert.equal(reads, 1);
  const row = JSON.parse(patches[0].raw as string).models.providers.local.models[1];
  assert.equal(row.thinkingLevelMap.medium, null);
  assert.equal(row.compat.thinkingFormat, undefined);
  await assert.rejects(settings.save({ ...input, thinkingLevel: "medium" }), /服务不支持/);
  assert.equal(patches.length, 1);
  await settings.save({ ...input, maxTokens: 16000 });
  assert.deepEqual((await settings.read()).thinkingLevels, saved.thinkingLevels);
});

test("unknown metadata and unavailable discovery never overwrite retained compatibility or leak secrets", async () => {
  const { settings, config } = fixture(false, undefined, async () => {
    throw new Error("synthetic-secret");
  });
  const provider = (config.models as any).providers.local;
  provider.models[0].compat = {
    thinkingFormat: "deepseek",
    supportedReasoningEfforts: ["low", "high"],
  };
  const saved = await settings.save({
    ...input,
    model: "example/model",
    api: "openai-completions",
    discover: true,
  });
  assert.deepEqual(saved.thinkingLevels, ["low", "high"]);
  assert.equal(provider.models[0].compat.thinkingFormat, "deepseek");
  await assert.rejects(
    settings.discover(),
    (error: Error) => !error.message.includes("synthetic-secret"),
  );
  await settings.save({
    ...input,
    model: "example/model",
    api: "openai-completions",
    baseUrl: "https://other.invalid/v1",
    apiKey: "replacement",
  });
  assert.equal((await settings.read()).thinkingLevels, undefined);
  assert.equal(provider.models[0].compat, undefined);
});

test("unknown compatible model default defers effort to the server instead of injecting medium", async () => {
  const { settings, patches } = fixture(false, undefined, async () =>
    Response.json({
      data: [{ id: "new-model", object: "model" }],
    }),
  );
  const saved = await settings.save({
    ...input,
    reasoning: true,
    thinkingLevel: null,
    discover: true,
  });
  assert.deepEqual(saved.thinkingLevels, []);
  const row = JSON.parse(patches[0].raw as string).models.providers.local.models[1];
  assert.equal(row.compat.supportsReasoningEffort, false);
  assert.equal(row.compat.thinkingFormat, undefined);
});
