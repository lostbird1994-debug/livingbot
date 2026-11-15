import type { AdapterContext } from "./types.js";

/** Stop this producer while leaving durable external work available for the next owner. */
export class RunInterruptedError extends Error {
  constructor(readonly reason: "lease_lost" | "shutdown") {
    super(`Run execution interrupted: ${reason}`);
    this.name = "RunInterruptedError";
  }
}

export function createAdapterContext(
  actor: Pick<AdapterContext, "spaceId" | "userId">,
  botId: string,
  operationId: string,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}
