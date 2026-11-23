import {
  ModelCatalogEntrySchema,
  ModelCredentialSchema,
  ModelRoleViewSchema,
} from "@livingbot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "../../../../packages/kernel-runtime/src/model-settings";
import type {
  LocalModelSettingsConnection,
  LocalModelSettingsRequest,
} from "./local-model-settings";
import { handleLocalModelSettings, readLocalModelDefaults } from "./local-model-settings";

const connection: LocalModelSettingsConnection = {
  origin: "http://127.0.0.1:4312",
  token: "synthetic-token",
};
let settings: ModelSettings;
let request: ReturnType<typeof vi.fn<LocalModelSettingsRequest>> & LocalModelSettingsRequest;

beforeEach(() => {
  settings = {
    configured: true,
    id: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    model: "synthetic-model",
    hasKey: true,
    input: ["text", "image"],
  };
  request = vi.fn<LocalModelSettingsRequest>(
    async <T>(_connection: LocalModelSettingsConnection, _path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Partial<ModelSettings>;
        settings = { ...settings, ...body, configured: true, hasKey: true } as ModelSettings;
        if ("headers" in body)
          settings.headerNames = Object.keys((body as { headers: object }).headers);
      }
      return settings as T;
    },
  ) as ReturnType<typeof vi.fn<LocalModelSettingsRequest>> & LocalModelSettingsRequest;
});

describe("local model settings adapter", () => {
  it("maps native settings to the original catalog and redacted credential contracts", async () => {
    const catalog = await handleLocalModelSettings("models.list", undefined, connection, request);
    const credentials = await handleLocalModelSettings(
      "models.credentials",
      undefined,
      connection,
      request,
    );
    expect(catalog).toMatchObject({
      handled: true,
      value: [{ provider: "openai-compatible", id: "synthetic-model" }],
    });
    expect(credentials).toMatchObject({
      handled: true,
      value: [{ provider: "openai-compatible", hasKey: true, modelId: "synthetic-model" }],
    });
    if (catalog.handled) ModelCatalogEntrySchema.array().parse(catalog.value);
    if (credentials.handled) ModelCredentialSchema.array().parse(credentials.value);
    expect(JSON.stringify(credentials)).not.toContain("synthetic-token");
  });

  it("persists compatible connection credentials and protocol through the native save endpoint", async () => {
    const result = await handleLocalModelSettings(
      "models.connect",
      {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiProtocol: "responses",
        modelId: "next-model",
        apiKey: "synthetic-api-key",
        supportsImages: true,
      },
      connection,
      request,
    );
    expect(request).toHaveBeenCalledWith(
      connection,
      "/api/model-settings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          discover: true,
          id: "local",
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-responses",
          model: "next-model",
          input: ["text", "image"],
          apiKey: "synthetic-api-key",
        }),
      }),
    );
    expect(result).toMatchObject({ handled: true, value: { modelId: "next-model", hasKey: true } });
  });

  it("does not claim unsupported probing, disconnection or role writes succeeded", async () => {
    for (const procedure of ["models.probeCatalog", "models.disconnect"]) {
      await expect(handleLocalModelSettings(procedure, {}, connection, request)).rejects.toThrow(
        "暂不支持",
      );
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("saves supported advanced settings and reads real native fields through the original contracts", async () => {
    const result = await handleLocalModelSettings(
      "models.connect",
      {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "next-model",
        headers: { "X-Key": "synthetic-secret" },
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: 64000,
        contextWindow: 256000,
        supportsImages: true,
      },
      connection,
      request,
    );
    expect(result).toMatchObject({
      handled: true,
      value: {
        headerNames: ["X-Key"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: 64000,
        contextWindow: 256000,
        supportsImages: true,
      },
    });
    if (result.handled) ModelCredentialSchema.parse(result.value);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(
      await handleLocalModelSettings("models.credentials", {}, connection, request),
    ).toMatchObject({
      value: [{ maxTokens: 64000, contextWindow: 256000, thinkingLevel: "high" }],
    });
  });

  it("keeps the native provider identity and stored key when editing the existing connection", async () => {
    settings.id = "existing-provider";
    await handleLocalModelSettings(
      "models/connect",
      {
        provider: "openai-compatible",
        credentialId: "local:existing-provider",
        makeDefault: false,
        baseUrl: settings.baseUrl,
        modelId: "new/model",
        apiProtocol: "anthropic-messages",
      },
      connection,
      request,
    );
    const body = JSON.parse(String(request.mock.calls.at(-1)?.[2]?.body));
    expect(body).toMatchObject({
      id: "existing-provider",
      model: "new/model",
      api: "anthropic-messages",
      input: ["text", "image"],
    });
    expect(body).not.toHaveProperty("apiKey");
  });

  it("loads main defaults from native settings and makes unchanged role selection idempotent", async () => {
    expect(await readLocalModelDefaults(connection, request)).toEqual({
      needsModel: false,
      defaultProvider: "openai-compatible",
      defaultModel: "synthetic-model",
    });
    const result = await handleLocalModelSettings(
      "models.role",
      { role: "main" },
      connection,
      request,
    );
    if (!result.handled) throw new Error("Expected main role");
    const role = ModelRoleViewSchema.parse(result.value);
    expect(
      await handleLocalModelSettings(
        "models.setRole",
        {
          role: "main",
          primary: role.primary,
          backups: [],
        },
        connection,
        request,
      ),
    ).toEqual(result);
    expect(
      await handleLocalModelSettings("models.setDefault", role.primary, connection, request),
    ).toEqual({ handled: true, value: { ok: true } });
    expect(request.mock.calls.every((call) => call[2]?.method !== "POST")).toBe(true);
  });

  it("offers the original compatible entry even before any model has been configured", async () => {
    settings.configured = false;
    settings.model = "";
    settings.hasKey = false;
    expect(await readLocalModelDefaults(connection, request)).toEqual({
      needsModel: true,
      defaultProvider: null,
      defaultModel: null,
    });
    expect(
      await handleLocalModelSettings("models.list", undefined, connection, request),
    ).toMatchObject({
      handled: true,
      value: [{ placeholder: true, provider: "openai-compatible" }],
    });
    expect(
      await handleLocalModelSettings("models.credentials", undefined, connection, request),
    ).toEqual({ handled: true, value: [] });
    expect(
      await handleLocalModelSettings("models.role", { role: "main" }, connection, request),
    ).toEqual({ handled: true, value: { primary: null, backups: [] } });
  });

  it("propagates native save failures without returning a success receipt", async () => {
    request.mockRejectedValueOnce(new Error("native read failed"));
    await expect(
      handleLocalModelSettings(
        "models.connect",
        {
          provider: "openai-compatible",
          baseUrl: settings.baseUrl,
          modelId: "next",
        },
        connection,
        request,
      ),
    ).rejects.toThrow("native read failed");
    request.mockRejectedValueOnce(new Error("native save not confirmed"));
    await expect(
      handleLocalModelSettings(
        "models.connect",
        {
          provider: "openai-compatible",
          baseUrl: settings.baseUrl,
          modelId: "next",
        },
        connection,
        request,
      ),
    ).rejects.toThrow("native save not confirmed");
  });

  it("rejects secret reuse on another endpoint, unsupported options and default-changing side effects", async () => {
    const basic = {
      provider: "openai-compatible",
      baseUrl: settings.baseUrl,
      modelId: settings.model,
    };
    for (const extra of [
      { credentialId: null },
      { credentialId: "local:stale" },
      { baseUrl: "https://example.invalid/v1" },
      { baseUrl: "https://example.invalid/v1?key=synthetic" },
      { maxImagesPerPrompt: 3 },
      { enabledModelIds: ["another-model"] },
    ]) {
      await expect(
        handleLocalModelSettings("models.connect", { ...basic, ...extra }, connection, request),
      ).rejects.toThrow();
    }
    for (const input of [
      { role: "approval" },
      { role: "main", primary: null },
      { role: "main", backups: [{ provider: "openai-compatible", modelId: "other" }] },
      { role: "main", primary: { provider: "openai-compatible", modelId: "other" } },
    ]) {
      await expect(
        handleLocalModelSettings("models.setRole", input, connection, request),
      ).rejects.toThrow();
    }
    expect(request.mock.calls.every((call) => call[2]?.method !== "POST")).toBe(true);
  });

  it("lets unrelated procedures fall through without reading model settings", async () => {
    expect(await handleLocalModelSettings("bots.list", undefined, connection, request)).toEqual({
      handled: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("uses precise defaults only for older native responses and preserves optional field omissions", async () => {
    expect(
      await handleLocalModelSettings("models.credentials", {}, connection, request),
    ).toMatchObject({ value: [{ maxTokens: 32000, contextWindow: 128000 }] });
    await handleLocalModelSettings(
      "models.connect",
      {
        provider: "openai-compatible",
        baseUrl: settings.baseUrl,
        modelId: settings.model,
      },
      connection,
      request,
    );
    const body = JSON.parse(String(request.mock.calls.at(-1)?.[2]?.body));
    for (const field of ["headers", "reasoning", "thinkingLevel", "contextWindow", "maxTokens"])
      expect(body).not.toHaveProperty(field);
  });

  it("can clear headers and persist/reset main thinking through the native endpoint", async () => {
    await handleLocalModelSettings(
      "models.connect",
      {
        provider: "openai-compatible",
        baseUrl: settings.baseUrl,
        modelId: settings.model,
        headers: {},
      },
      connection,
      request,
    );
    expect(settings.headerNames).toEqual([]);
    await handleLocalModelSettings(
      "models.setRole",
      {
        role: "main",
        primary: {
          provider: "openai-compatible",
          modelId: settings.model,
          credentialId: "local:local",
          thinkingLevel: "high",
        },
      },
      connection,
      request,
    );
    expect(settings.thinkingLevel).toBe("high");
    const result = await handleLocalModelSettings(
      "models.setRole",
      {
        role: "main",
        primary: {
          provider: "openai-compatible",
          modelId: settings.model,
          credentialId: "local:local",
          thinkingLevel: null,
        },
      },
      connection,
      request,
    );
    expect(settings.thinkingLevel).toBe(null);
    if (result.handled) ModelRoleViewSchema.parse(result.value);
  });
});

it("refreshes only the saved endpoint and returns declared effort choices", async () => {
  settings.thinkingLevels = ["low", "high", "xhigh"];
  const refreshed = await handleLocalModelSettings(
    "models.probeOpenAiCompatible",
    {
      baseUrl: settings.baseUrl,
      credentialId: "local:local",
      apiProtocol: "chat-completions",
    },
    connection,
    async <T>() => settings as T,
  );
  expect(refreshed).toMatchObject({ handled: true, value: { models: [settings.model] } });
  await expect(
    handleLocalModelSettings(
      "models.probeOpenAiCompatible",
      {
        baseUrl: "https://other.invalid/v1",
        credentialId: "local:local",
      },
      connection,
      request,
    ),
  ).rejects.toThrow("请先保存");
  const result = await handleLocalModelSettings(
    "models.credentials",
    undefined,
    connection,
    request,
  );
  expect(result).toMatchObject({ value: [{ thinkingLevels: ["low", "high", "xhigh"] }] });
});
