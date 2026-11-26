// Native lifecycle/authority and the existing authenticated loopback tool bridge.
export function registerBotHealth(api, target, token) {
  const call = async (path, context, args = {}, signal) => {
    const response = await fetch(new URL(path, target), {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...args,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        runId: context.runId,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Bot 体检暂不可用");
    return result;
  };
  api.on(
    "before_prompt_build",
    async (_event, context) => {
      if (!context.agentId || !context.sessionKey || !context.runId) return;
      context.hookInvocation?.assertActive();
      const policy = await call("/api/kernel/bot-health-policy", context, {}, context.abortSignal);
      context.hookInvocation?.assertActive();
      return { appendSystemContext: policy.instructions };
    },
    { priority: -20 },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create(context) {
        if (!context.agentId || !context.sessionKey || !context.runId) return null;
        return {
          name: "livingbot_health_check",
          label: "Bot 体检",
          description:
            "Inspect your workspace, loaded context, memory and exclusive skills using your normal tools, including reading relevant external reference files and parsing binary documents. Begin first. Read every exclusive skill body. Every finding MUST have plan.steps plus executable actions, or a specific plan.limitation for a genuinely missing input. Use kind instruction for fixes you will perform yourself with your normal tools (Workshop-managed skills, integrations, anything that is not a plain text file); the host hands approved instruction steps back to you as a normal request. Prepare concrete plans during inspection; the host publishes a report card and executes approved file changes in one batch. Memory files are supported. Relative paths use your workspace; absolute paths address relevant external files. No scores. Excludes full historical chat and external database consistency audits.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["operation"],
            properties: {
              operation: {
                type: "string",
                enum: [
                  "begin",
                  "context",
                  "list_files",
                  "read_file",
                  "file_info",
                  "tasks",
                  "skills",
                  "read_skill",
                  "submit_report",
                ],
              },
              onlyInspect: { type: "boolean" },
              path: { type: "string" },
              skillKey: { type: "string" },
              summary: { type: "string" },
              complete: { type: "boolean" },
              gaps: { type: "array", items: { type: "string" } },
              issues: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "id",
                    "category",
                    "priority",
                    "certainty",
                    "title",
                    "problem",
                    "impact",
                    "suggestion",
                    "evidence",
                    "actions",
                    "plan",
                  ],
                  properties: {
                    id: { type: "string" },
                    category: {
                      type: "string",
                      enum: ["context", "memory", "skills", "workspace"],
                    },
                    priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
                    certainty: { type: "string", enum: ["confirmed", "suggestion", "unverified"] },
                    title: { type: "string" },
                    problem: { type: "string" },
                    impact: { type: "string" },
                    suggestion: { type: "string" },
                    plan: {
                      type: "object",
                      additionalProperties: false,
                      required: ["steps"],
                      properties: {
                        steps: { type: "array", minItems: 1, items: { type: "string" } },
                        limitation: { type: "string" },
                        diagram: { type: "string", description: "Optional Mermaid source explaining a complex relationship or workflow." },
                        illustration: {
                          type: "object",
                          additionalProperties: false,
                          required: ["title", "format", "code"],
                          properties: {
                            title: { type: "string" },
                            format: { type: "string", enum: ["svg", "html"] },
                            code: { type: "string", description: "Raw SVG/HTML fragment for the existing isolated inline visual renderer. Explanations only; no approval controls." },
                          },
                        },
                      },
                    },
                    evidence: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["path", "excerpt"],
                        properties: {
                          path: { type: "string" },
                          excerpt: { type: "string" },
                        },
                      },
                    },
                    actions: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "kind", "explanation"],
                        properties: {
                          id: { type: "string" },
                          kind: { type: "string", enum: ["write", "trash", "instruction"] },
                          path: { type: "string", description: "File path for write/trash." },
                          expectedDigest: { type: "string", description: "Digest from read_file for write/trash." },
                          explanation: { type: "string" },
                          target: {
                            type: "string",
                            description: "instruction: what will be changed, e.g. a Workshop skill name.",
                          },
                          steps: {
                            type: "array",
                            minItems: 1,
                            items: { type: "string" },
                            description: "instruction: concrete steps you will carry out with your normal tools.",
                          },
                          content: { type: "string" },
                          retainedPath: { type: "string" },
                          retainedDigest: { type: "string" },
                          referencePaths: { type: "array", items: { type: "string" } },
                          uniqueContent: { type: "string" },
                          referencesChecked: { type: "boolean" },
                          processesChecked: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          async execute(_toolCallId, args, signal) {
            context.assertInvocationCurrent();
            const result = await call("/api/kernel/bot-health", context, args, signal);
            context.assertInvocationCurrent();
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          },
        };
      },
    },
    { name: "livingbot_health_check", workspaceAccess: false },
  );
}
