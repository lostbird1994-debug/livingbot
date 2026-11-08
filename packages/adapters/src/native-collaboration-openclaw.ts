import {
  NATIVE_COLLABORATION_TOOLS,
  NativeCollaborationBroker,
} from "./native-collaboration-broker.js";

// OpenClaw loads separate gateway and tool-discovery registries in one process.
// They must share pending calls, including when it imports the extension again.
const processState = globalThis as unknown as Record<symbol, NativeCollaborationBroker>;
const brokerKey = Symbol.for("rakazo.collaboration.broker.v1");
const broker = processState[brokerKey] ?? new NativeCollaborationBroker();
processState[brokerKey] = broker;

// Structural boundary keeps OpenClaw optional; the extension is bundled separately.
interface PluginApi {
  registerGatewayMethod(
    name: string,
    handler: (options: {
      params: Record<string, unknown>;
      respond(ok: boolean, payload?: unknown, error?: { code: string; message: string }): void;
    }) => void,
    options: { scope: "operator.write" },
  ): void;
  registerTool(
    factory: (context: { sessionKey?: string }) => unknown,
    options: { names: string[] },
  ): void;
}
export default {
  id: "rakazo-collaboration",
  name: "Rakazo collaboration",
  register(api: PluginApi) {
    for (const method of ["register", "poll", "resolve", "close"] as const) {
      api.registerGatewayMethod(
        `rakazo.tools.${method}`,
        ({ params, respond }) => {
          try {
            respond(true, broker[method](params));
          } catch {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "Rakazo collaboration request rejected",
            });
          }
        },
        { scope: "operator.write" },
      );
    }
    api.registerTool(
      (context) => {
        if (!context.sessionKey) return null;
        const sessionKey = context.sessionKey;
        const { runId, tools } = broker.tools(sessionKey);
        return tools.map((tool) => ({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          async execute(id: string, args: Record<string, unknown>, signal?: AbortSignal) {
            signal?.throwIfAborted();
            const cancel = () => {
              try {
                broker.cancel(sessionKey, runId, id);
              } catch {
                /* Grant already closed. */
              }
            };
            const pending = broker.call(sessionKey, runId, { id, name: tool.name, args });
            signal?.addEventListener("abort", cancel, { once: true });
            try {
              const result = await pending;
              signal?.throwIfAborted();
              return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
            } finally {
              signal?.removeEventListener("abort", cancel);
            }
          },
        }));
      },
      { names: [...NATIVE_COLLABORATION_TOOLS] },
    );
  },
};
