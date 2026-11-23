import { isAbsolute } from "node:path";
import { validateAgentId } from "./config.ts";
import type { GatewayRequests } from "./contracts.ts";

export interface AgentRegistration {
  ensure(input: { agentId: string; workspace: string }): Promise<void>;
}

/** Additive native configuration; it never replaces an existing agent. */
export class OpenClawAgents implements AgentRegistration {
  private readonly gateway: GatewayRequests;
  constructor(gateway: GatewayRequests) { this.gateway = gateway; }

  async ensure(input: { agentId: string; workspace: string }): Promise<void> {
    validateAgentId(input.agentId);
    if (!isAbsolute(input.workspace)) throw new Error("Agent workspace must be absolute");
    const snapshot = await this.gateway.request<{
      hash?: string; config: { agents?: { entries?: Record<string, { workspace?: string }> } };
    }>("config.get", {});
    const entry = snapshot.config.agents?.entries?.[input.agentId];
    if (entry) {
      if (entry.workspace !== input.workspace) throw new Error("Agent already has another workspace");
      return;
    }
    if (!snapshot.hash) throw new Error("Configuration revision is unavailable");
    await this.gateway.request("config.patch", {
      baseHash: snapshot.hash,
      raw: JSON.stringify({ agents: { entries: { [input.agentId]: {
        workspace: input.workspace, memory: { search: { rememberAcrossConversations: true } },
      } } } }),
      response: "summary",
    });
    const confirmed = await this.gateway.request<typeof snapshot>("config.get", {});
    if (confirmed.config.agents?.entries?.[input.agentId]?.workspace !== input.workspace) {
      throw new Error("Agent registration has not been confirmed; retry this import");
    }
  }
}
