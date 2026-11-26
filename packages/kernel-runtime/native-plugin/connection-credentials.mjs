/** Metadata-only tool: human input goes directly to the host's credential route. */
export function registerConnectionCredentials(api, target, token) {
  api.registerTool({
    contextVersion: 2,
    create(context) {
      if (context.agentId !== "system-super-admin" || !context.sessionKey || !context.runId) return null;
      return {
        name: "livingbot_configure_credentials", label: "配置连接凭证",
        description: "Ask the user for credentials in a masked LivingBot conversation card and save them directly to an EXISTING shared MCP connection. Values are never returned to you. Read the service documentation first. Supply the connection name and its documented env (stdio) or headers (HTTP) field keys and human labels. One card accepts up to eight fields. Do not ask for values in chat or tool arguments. A saved result confirms configuration only, not successful remote authentication; verify the actual service afterward. OAuth uses native account sign-in instead.",
        parameters: {
          type: "object", additionalProperties: false, required: ["connection", "target", "fields"],
          properties: {
            connection: { type: "string", minLength: 1, maxLength: 100 },
            target: { type: "string", enum: ["env", "headers"] },
            fields: {
              type: "array", minItems: 1, maxItems: 8,
              items: {
                type: "object", additionalProperties: false, required: ["key", "label"],
                properties: { key: { type: "string", maxLength: 128 }, label: { type: "string", maxLength: 64 } },
              },
            },
          },
        },
        async execute(toolCallId, args, signal) {
          const post = async (input) => {
            signal?.throwIfAborted();
            context.assertInvocationCurrent();
            const response = await fetch(new URL("/api/kernel/connection-credentials", target), {
              method: "POST", redirect: "error",
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({
                ...input, agentId: context.agentId, sessionKey: context.sessionKey, runId: context.runId,
              }),
            });
            const result = await response.json();
            context.assertInvocationCurrent();
            if (!response.ok) throw new Error("连接凭证请求不可用");
            return result;
          };
          let result = await post({ ...args, toolCallId });
          const deadline = Date.now() + 16 * 60_000;
          while (["pending", "answering"].includes(result.status) && Date.now() < deadline) {
            await new Promise((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(new Error("Credential request cancelled")); };
              const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 1000);
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
            result = await post({ operation: "status", id: result.id });
          }
          const details = { status: result.status === "answered" ? "saved" : result.status, connection: args.connection, verified: false };
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        },
      };
    },
  }, { name: "livingbot_configure_credentials", workspaceAccess: false });
}
