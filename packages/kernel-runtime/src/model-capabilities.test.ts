import assert from "node:assert/strict";
import test from "node:test";
import { declaredModelCapabilities, discoverModelCapabilities } from "./model-capabilities.ts";

test("model identity alone never invents reasoning support or capacity", () => {
  assert.deepEqual(
    declaredModelCapabilities({ id: "deepseek-v4.1-flash", owned_by: "custom" }),
    {},
  );
  assert.deepEqual(
    declaredModelCapabilities({
      effort: { supported_levels: ["future-level"] },
      context_window: -1,
    }),
    {},
  );
});
test("declared effort sets and defaults are preserved without guessing the wire protocol", () => {
  const caps = declaredModelCapabilities({
    effort: { supported_levels: ["low", "high", "xhigh"], default_level: "high" },
    context_window: 128000,
    max_output_tokens: 32000,
    input_modalities: ["text", "image"],
  });
  assert.deepEqual(caps, {
    efforts: ["low", "high", "xhigh"],
    defaultEffort: "high",
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 32000,
    input: ["text", "image"],
  });
  assert.deepEqual(
    declaredModelCapabilities({
      capabilities: {
        thinking: { supported: true },
        effort: {
          low: { supported: true },
          medium: { supported: false },
          high: { supported: true },
        },
        image_input: { supported: false },
      },
    }),
    { reasoning: true, efforts: ["low", "high"], input: ["text"] },
  );
});
test("discovery uses exact configured model and backend credentials, bounds responses, disables redirects", async () => {
  const connection = {
    baseUrl: "https://example.invalid/v1",
    model: "exact-model",
    api: "openai-completions" as const,
    apiKey: "synthetic-secret",
    headers: { "X-Example": "synthetic-header" },
  };
  const mock: typeof fetch = async (url, options) => {
    assert.equal(String(url), "https://example.invalid/v1/models");
    assert.equal(options?.redirect, "error");
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("authorization"), "Bearer synthetic-secret");
    assert.equal(headers.get("X-Example"), "synthetic-header");
    return Response.json({
      data: [
        { id: "different-model", effort: { supported_levels: ["medium"] } },
        { id: "exact-model", effort: { supported_levels: ["high"] } },
      ],
    });
  };
  assert.deepEqual((await discoverModelCapabilities(connection, mock)).efforts, ["high"]);
  await assert.rejects(
    discoverModelCapabilities(connection, async () => new Response("x".repeat(1_048_577))),
    /exceeds limit/,
  );
  await assert.rejects(
    discoverModelCapabilities(connection, async () => new Response("secret", { status: 401 })),
    (error: Error) => !error.message.includes("secret"),
  );
});
