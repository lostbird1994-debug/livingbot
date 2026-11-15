import { EnvHttpProxyAgent } from "undici";
import { dispatcherFetch } from "./undici-fetch.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const PUBLIC_GITHUB_HOSTS = new Set(["raw.githubusercontent.com", "api.github.com"]);
let sharedProxy: { configuration: string; agent: EnvHttpProxyAgent } | undefined;

function proxyAgent() {
  const configuration = JSON.stringify([
    process.env.https_proxy,
    process.env.HTTPS_PROXY,
    process.env.http_proxy,
    process.env.HTTP_PROXY,
    process.env.no_proxy,
    process.env.NO_PROXY,
  ]);
  if (sharedProxy?.configuration !== configuration) {
    if (sharedProxy) void sharedProxy.agent.destroy().catch(() => undefined);
    sharedProxy = { configuration, agent: new EnvHttpProxyAgent() };
  }
  return sharedProxy.agent;
}

/** Only service-owned public GitHub reads may use the operator's trusted proxy.
 * URL/DNS, redirect, deadline and response-size checks still run in the safe reader.
 * The proxy resolves tunneled hosts, so every proxied hop is restricted to GitHub;
 * arbitrary user URLs continue to use the DNS-pinned direct transport. */
export async function readPublicGithubText(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const assertGithub = (value: string) => {
    const target = new URL(value);
    if (
      target.protocol !== "https:" ||
      !PUBLIC_GITHUB_HOSTS.has(target.hostname) ||
      (target.port && target.port !== "443")
    ) {
      throw new Error("Only public GitHub file hosts are allowed");
    }
  };
  assertGithub(url);
  const configured =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (!configured) return (await fetchSafeWebText(url, { maxBytes, signal })).body;
  const proxy = proxyAgent();
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    assertGithub(input instanceof Request ? input.url : String(input));
    return dispatcherFetch(input, { ...init, dispatcher: proxy } as RequestInit);
  }) as typeof globalThis.fetch;
  return (await fetchSafeWebText(url, { maxBytes, signal, fetch })).body;
}
