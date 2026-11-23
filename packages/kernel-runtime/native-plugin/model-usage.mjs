/** Forward the host's measured request duration; never measure it in the plugin. */
export function registerModelUsage(api, target, token) {
  api.on("model_call_ended", async (event, context) => {
    const sessionKey = event.sessionKey ?? context.sessionKey;
    if (!context.agentId || !sessionKey || !event.runId || !event.callId) return;
    context.hookInvocation?.assertActive();
    const response = await fetch(new URL("/api/kernel/model-usage", target), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        agentId: context.agentId, sessionKey, runId: event.runId, callId: event.callId,
        durationMs: event.durationMs, outcome: event.outcome,
        ...(event.timeToFirstByteMs !== undefined ? { timeToFirstByteMs: event.timeToFirstByteMs } : {}),
      }),
    });
    if (!response.ok) throw new Error("Model request usage recording failed");
  });
}
