import type { PeerFactory } from "./contracts.ts";

/** Vendor code is loaded only by the configured OpenClaw composition root. */
export const createOpenClawPeer: PeerFactory = async (options) => {
  const { GatewayClient } = await import("openclaw/plugin-sdk/gateway-runtime");
  return new GatewayClient({
    ...options,
    onEvent: (frame) => options.onEvent({
      event: frame.event,
      seq: frame.seq,
      payload: frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
        ? frame.payload as Record<string, unknown> : undefined,
    }),
    clientName: "gateway-client",
    clientDisplayName: "LivingBot",
    clientVersion: "2.0.0",
    mode: "backend",
    role: "operator",
    scopes: [
      "operator.read", "operator.write", "operator.admin",
      "operator.approvals", "operator.questions",
    ],
    caps: ["tool-events", "approvals", "inline-widgets"],
  });
};
