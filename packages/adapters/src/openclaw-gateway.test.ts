import { describe, expect, it, vi } from "vitest";
import { connectOpenClawKernelSdk, connectOpenClawSdk } from "./openclaw-gateway.js";

const connections = vi.hoisted(() => [] as any[]);
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: class {
    constructor(private options: any) { connections.push(options); }
    start() { this.options.onHelloOk(); }
    stop() {}
  },
}));

describe("trusted native kernel connection", () => {
  it("requests tool and recovery permissions even when no model is overridden", async () => {
    const peer = await connectOpenClawKernelSdk("ws://127.0.0.1:18789", "fake-token", () => {});
    expect(connections.at(-1)).toMatchObject({
      role: "operator", scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    });
    peer.stop();
  });
  it("does not elevate ordinary external gateway connections", async () => {
    const peer = await connectOpenClawSdk("wss://example.com", "fake-token", () => {});
    expect(connections.at(-1).scopes).not.toContain("operator.admin");
    peer.stop();
  });
  it.each(["wss://example.com", "ws://example.com", "ws://127.0.0.1.example.com", "ws://user@127.0.0.1", "ws://127.0.0.1?token=fake"])(
    "refuses privileged connections to untrusted endpoints: %s", async url => {
      const count = connections.length;
      await expect(async () => connectOpenClawKernelSdk(url, "fake-token", () => {})).rejects.toThrow("trusted local gateway");
      expect(connections).toHaveLength(count);
    },
  );
});
