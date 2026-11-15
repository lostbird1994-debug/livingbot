import type * as Undici from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn(), destroy: vi.fn(async () => {}) }));
vi.mock("./undici-fetch.js", () => ({
  dispatcherFetch: transport.fetch,
  fetchPairedWithDispatcher: (fetch?: typeof globalThis.fetch) => fetch ?? transport.fetch,
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
vi.mock("undici", async (original) => ({
  ...(await original<typeof Undici>()),
  EnvHttpProxyAgent: class {
    destroy = transport.destroy;
  },
}));
let readPublicGithubText: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<string>;

beforeEach(async () => {
  vi.resetModules();
  ({ readPublicGithubText } = await import("./github-public-text.js"));
  vi.clearAllMocks();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) vi.stubEnv(key, "");
  transport.fetch.mockImplementation(async () => new Response("public catalog"));
});
afterEach(() => vi.unstubAllEnvs());

it("keeps the direct safe transport when no proxy is configured", async () => {
  expect(
    await readPublicGithubText(
      "https://raw.githubusercontent.com/example/plugins/HEAD/index.json",
      100,
    ),
  ).toBe("public catalog");
  expect(transport.destroy).not.toHaveBeenCalled();
});
it.each(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])(
  "uses the trusted proxy configured by %s",
  async (key) => {
    vi.stubEnv(key, "http://127.0.0.1:8080");
    expect(
      await readPublicGithubText(
        "https://raw.githubusercontent.com/example/plugins/HEAD/index.json",
        100,
      ),
    ).toBe("public catalog");
    expect(transport.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        redirect: "manual",
        dispatcher: expect.objectContaining({ destroy: transport.destroy }),
      }),
    );
  },
);
it.each([
  "https://example.test/file",
  "https://raw.githubusercontent.com.evil.test/file",
  "http://api.github.com/file",
  "https://api.github.com:8443/file",
])("refuses a non-GitHub HTTPS file URL: %s", async (url) => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8080");
  await expect(readPublicGithubText(url, 100)).rejects.toThrow("Only public GitHub");
  expect(transport.fetch).not.toHaveBeenCalled();
});
it("refuses a redirect to another public host before proxy dispatch", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8080");
  transport.fetch.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: "https://example.test/other" } }),
  );
  await expect(readPublicGithubText("https://api.github.com/file", 100)).rejects.toThrow(
    "Only public GitHub",
  );
  expect(transport.fetch).toHaveBeenCalledOnce();
});
it("still bounds proxied response bodies and closes on failure", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8080");
  await expect(readPublicGithubText("https://api.github.com/file", 2)).rejects.toThrow(
    "Response is too large",
  );
});
it("does not dispatch an already aborted request", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8080");
  const controller = new AbortController();
  controller.abort();
  await expect(
    readPublicGithubText("https://api.github.com/file", 100, controller.signal),
  ).rejects.toThrow();
  expect(transport.fetch).not.toHaveBeenCalled();
});

it("reuses the proxy transport across public file reads", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8080");
  await readPublicGithubText("https://api.github.com/one", 100);
  await readPublicGithubText("https://raw.githubusercontent.com/two", 100);
  expect(transport.fetch.mock.calls[0]![1].dispatcher).toBe(
    transport.fetch.mock.calls[1]![1].dispatcher,
  );
});
