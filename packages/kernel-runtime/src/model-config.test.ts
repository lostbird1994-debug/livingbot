import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildKernelConfig, modelLimits } from "./config.ts";
import { runtimePaths } from "./paths.ts";

const connection = {
  id: "synthetic",
  baseUrl: "https://example.invalid/v1",
  api: "openai-responses" as const,
  apiKey: "synthetic-secret",
  model: "example/model",
};

test("native boot config uses the same explicit context/output defaults", () => {
  assert.deepEqual(modelLimits(undefined, undefined), { contextWindow: 128000, maxTokens: 32000 });
  const config = buildKernelConfig(
    runtimePaths("/synthetic/runtime"),
    45123,
    "synthetic",
    [{ id: "test" }],
    connection,
  ) as any;
  assert.equal(config.models.providers.synthetic.models[0].contextWindow, 128000);
  assert.equal(config.models.providers.synthetic.models[0].maxTokens, 32000);
});

test("advanced boot configuration matches installed exact 2026.11.5 schema and thinking resolver", async () => {
  const native = new URL("../node_modules/openclaw/", import.meta.url);
  assert.equal(
    JSON.parse(await readFile(new URL("package.json", native), "utf8")).version,
    "2026.11.5",
  );
  // Test the pinned installed schema, without importing its private bundles in product code.
  const { t: schema } = await import(new URL("dist/zod-schema-ouu-PUnd.mjs", native).href);
  const { n: resolveThinking } = await import(
    new URL("dist/model-thinking-default-IzoVwfub.mjs", native).href
  );
  const config = buildKernelConfig(
    runtimePaths("/synthetic/runtime"),
    45123,
    "synthetic",
    [{ id: "test" }],
    {
      ...connection,
      headers: { "X-Key": "synthetic-header" },
      reasoning: true,
      thinkingLevel: "high",
      contextWindow: 256000,
      maxTokens: 64000,
      input: ["text", "image"],
    },
  ) as any;
  assert.equal(schema.safeParse(config).success, true);
  assert.equal(config.models.providers.synthetic.headers["X-Key"], "synthetic-header");
  assert.equal(
    resolveThinking({ cfg: config, provider: "synthetic", model: "example/model" }),
    "high",
  );
  config.agents.defaults.models["synthetic/example/model"].params.thinking = "off";
  assert.equal(
    resolveThinking({ cfg: config, provider: "synthetic", model: "example/model" }),
    "off",
  );
  config.models.providers.synthetic.models[0].maxImagesPerPrompt = 4;
  assert.equal(schema.safeParse(config).success, false);
});
