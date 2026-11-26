// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ArtifactSchema,
  ArtifactWithContentSchema,
  ThreadSnapshotSchema,
  GroupSchema,
  UsageSummarySchema,
} from "@livingbot/contracts";
import {
  adoptConnection,
  forgetConnection,
  localConnected,
  localConnection,
  localRpc,
  openLocalThreadEvents,
  subscribeLocalResults,
} from "./local-workbench";

const prompt = {
  id: "question:one",
  engineId: "one",
  kind: "question",
  taskId: "task-1",
  runId: "run-1",
  conversationId: "conversation-1",
  sessionKey: "synthetic",
  generation: 1,
  title: "选择交付位置",
  status: "pending",
  createdAt: 2,
  expiresAt: 9999999999999,
  decisions: [],
  questions: [
    {
      id: "target",
      question: "选择交付位置",
      header: "",
      multiSelect: false,
      allowOther: true,
      options: [{ value: "local", label: "本机文件" }],
    },
  ],
};
const calls: { path: string; body: unknown }[] = [];

it.each([
  { modelProvider: "example", modelId: "example" },
  { thinkingLevel: "high" },
])(
  "rejects unsupported per-Bot model overrides before making a request: %j",
  async (override) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(localRpc("bots.update", {
      botId: "bot-1", name: "Example", ...override,
    })).rejects.toThrow("本机模型由全局设置统一管理");
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each(["crossSpaceCommunication", "fleetManagement"])(
  "rejects unsupported %s before making any local request",
  async (field) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const value of [true, false]) {
      await expect(localRpc("bots.update", {
        botId: "bot-1", name: "Example", [field]: value,
      })).rejects.toThrow("本机模式暂不支持");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it("maps workspace native usage to the summary contract while leaving costs unknown", async () => {
  const fetchMock = vi.fn(async (_input: string) => Response.json({
    runs: 3,
    sessions: [{
      usage: {
        input: 10, output: 20, cacheRead: 5, cacheWrite: 0,
        totalTokens: 35, latency: { count: 2 }, cost: 99,
      },
    }],
  }));
  vi.stubGlobal("fetch", fetchMock);
  const summary = UsageSummarySchema.parse(await localRpc("usage.summary", {}, "space-project"));
  expect(summary).toEqual({
    runs: 3, modelCalls: 2, inputTokens: 15, outputTokens: 20,
    totalTokens: 35, costUsd: null, models: [],
  });
  const url = new URL(fetchMock.mock.calls[0]![0]);
  expect(url.pathname).toBe("/api/usage");
  expect(url.searchParams.get("spaceId")).toBe("space-project");
});

it("returns the saved read-aloud preference instead of replacing it with a fixed default", async () => {
  let saved = { id: "bot-1", name: "Example", agentId: "example", autoSpeak: false };
  const patches: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/private-conversation")) return Response.json({ id: "main" });
    if (path === "/api/bots/bot-1" && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      saved = { ...saved, ...patch };
      return Response.json(saved);
    }
    return Response.json({ error: "Unexpected request" }, { status: 500 });
  }));
  for (const autoSpeak of [true, false]) {
    await expect(localRpc("bots.update", { botId: "bot-1", autoSpeak }))
      .resolves.toMatchObject({ autoSpeak });
  }
  expect(patches).toEqual([
    { botId: "bot-1", autoSpeak: true }, { botId: "bot-1", autoSpeak: false },
  ]);
});

it("connects a cold desktop renderer through the 2.0 preload without URL credentials", async () => {
  forgetConnection();
  const connect = vi.fn(async () => ({ origin: "http://127.0.0.1:1234", token: "synthetic" }));
  Object.assign(window, { livingbotDesktop: { connect } });
  try {
    expect(await localConnection()).toEqual({ origin: "http://127.0.0.1:1234", token: "synthetic" });
    expect(localConnected()).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
  } finally { Reflect.deleteProperty(window, "livingbotDesktop"); }
});

it("routes local space creation, rename and removal to persistent endpoints", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path === "/api/spaces" && method === "POST") {
      return Response.json({ id: "space-project", name: (body as { name: string }).name });
    }
    if (path === "/api/spaces/space-project" && method === "PATCH") {
      return Response.json({ id: "space-project", name: (body as { name: string }).name });
    }
    return Response.json({ ok: true, activeSpaceId: "local" });
  }));
  const created = await localRpc("spaces.create", { name: "Project" }) as {
    id: string; name: string; isDefault: boolean; bots: unknown[];
  };
  expect(created).toMatchObject({ id: "space-project", name: "Project", isDefault: false, bots: [] });
  await expect(localRpc("spaces.rename", { spaceId: created.id, name: "Renamed" }))
    .resolves.toEqual({ id: created.id, name: "Renamed" });
  await expect(localRpc("spaces.remove", { spaceId: created.id }))
    .resolves.toEqual({ ok: true, activeSpaceId: "local" });
  expect(requests.map(({ path, method }) => [path, method])).toEqual([
    ["/api/spaces", "POST"],
    ["/api/spaces/space-project", "PATCH"],
    ["/api/spaces/space-project", "DELETE"],
  ]);
});

it("loads the local Bot roster without depending on model or routine services", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    requested.push(url.pathname);
    if (url.pathname === "/api/snapshot") {
      return Response.json({
        bots: [], conversations: [], tasks: [], interactions: [], readState: [],
        lastMessageSeq: {}, lastMessages: {},
      });
    }
    if (url.pathname === "/api/spaces") {
      return Response.json({ spaces: [{
        id: "local", name: "本机", createdAt: 1, isDefault: true,
        canRename: false, canDelete: false, hasContent: false, botCount: 0,
        bots: [], groups: [], botSections: [],
      }] });
    }
    if (url.pathname === "/api/bot-sections") return Response.json({ sections: [] });
    if (url.pathname === "/api/preferences") return Response.json({ id: "preferences" });
    return Response.json({ error: "optional service unavailable" }, { status: 503 });
  }));

  const roster = await localRpc("spaces.list", {}) as {
    current: { id: string };
    spaces: { id: string }[];
  };
  expect(roster.current.id).toBe("local");
  expect(roster.spaces.map((space) => space.id)).toEqual(["local"]);
  expect(requested).not.toContain("/api/model-settings");
  expect(requested).not.toContain("/api/routines");
});

it("parallel workspace-scoped rosters keep their own Bots without changing the selected workspace", async () => {
  const bots = [
    { id: "bot-local", name: "Local", agentId: "local-example", spaceId: "local", createdAt: 1 },
    { id: "bot-project", name: "Project", agentId: "project-example", spaceId: "project", createdAt: 1 },
  ];
  window.localStorage.setItem("rakazo:space-id", "local");
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    if (path === "/api/snapshot") return Response.json({
      bots, conversations: [], tasks: [], interactions: [], readState: [], lastMessageSeq: {}, lastMessages: {},
    });
    if (path === "/api/spaces") return Response.json({ spaces: ["local", "project"].map((id) => ({
      id, name: id, createdAt: 1, isDefault: id === "local", canRename: id !== "local", canDelete: id !== "local",
      hasContent: true, botCount: 1, bots: bots.filter((bot) => bot.spaceId === id), groups: [], botSections: [],
    })) });
    if (path === "/api/bot-sections") return Response.json({ sections: [] });
    return Response.json({});
  }));
  const [home, project] = await Promise.all([
    localRpc("spaces.list", {}, "local"), localRpc("spaces.list", {}, "project"),
  ]) as [
    { current: { bots: { id: string }[] } },
    { current: { bots: { id: string }[] } },
  ];
  expect(home.current.bots.map((bot) => bot.id)).toEqual(["bot-local"]);
  expect(project.current.bots.map((bot) => bot.id)).toEqual(["bot-project"]);
  expect(window.localStorage.getItem("rakazo:space-id")).toBe("local");
});

it("routes the Bot to-do RPCs to the persistent local endpoints", async () => {
  const requested: { path: string; method: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    requested.push({ path: `${url.pathname}${url.search}`, method });
    if (url.pathname === "/api/scratchpad" && method === "GET") {
      return Response.json([]);
    }
    if (url.pathname === "/api/scratchpad" && method === "POST") {
      return Response.json({ id: "todo-1", botId: "bot-1", title: "Task", status: "open" }, { status: 201 });
    }
    if (url.pathname.endsWith("/update")) {
      return Response.json({ id: "todo-1", botId: "bot-1", title: "Task", status: "done" });
    }
    return Response.json({ ok: true });
  }));

  await localRpc("scratchpad.list", { botId: "bot-1" });
  await localRpc("scratchpad.create", { botId: "bot-1", title: "Task" });
  await localRpc("scratchpad.update", { itemId: "todo-1", status: "done" });
  await localRpc("scratchpad.remove", { itemId: "todo-1" });

  expect(requested).toEqual([
    { path: "/api/scratchpad?botId=bot-1", method: "GET" },
    { path: "/api/scratchpad", method: "POST" },
    { path: "/api/scratchpad/todo-1/update", method: "PATCH" },
    { path: "/api/scratchpad/todo-1/remove", method: "DELETE" },
  ]);
});

it("opens the actual notification destination and retains its read receipt", async () => {
  let receive: ((id: string) => void) | undefined;
  const unsubscribe = vi.fn();
  const open = vi.fn();
  Object.assign(window, { livingbotDesktop: { onOpenResult: (callback: (id: string) => void) => {
    receive = callback; return unsubscribe;
  } } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: undefined });
    return Response.json(path === "/api/snapshot" ? {
      conversations: [{ id: "group-1", kind: "group" }],
      notifications: [{ id: "notice-1", conversationId: "group-1", botId: "bot-1" }],
    } : {});
  }));
  try {
    const stop = subscribeLocalResults(open);
    receive?.("notice-1");
    await vi.waitFor(() => expect(calls.some((call) => call.path === "/api/notifications/notice-1/read")).toBe(true));
    expect(open).toHaveBeenCalledWith("/app/g/group-1");
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally { Reflect.deleteProperty(window, "livingbotDesktop"); }
});
let failCancel = false;
beforeEach(() => {
  calls.length = 0;
  failCancel = false;
  forgetConnection();
  adoptConnection({ origin: "http://127.0.0.1:1234", token: "synthetic" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      if (path === "/api/files/file-1" && !new URL(url).search) return new Response("交付");
      const value = path.endsWith("/private-conversation")
        ? { id: "conversation-1" }
        : path === "/api/snapshot"
          ? {
              bots: [],
              conversations: [],
              tasks: [{ id: "task-1", conversationId: "conversation-1", status: "waiting" }],
              interactions: [prompt],
              artifacts: [{ id: "file-1", bytes: 42 }],
            }
          : path.endsWith("/messages")
            ? {
                cursor: 37,
                messages: [
                  {
                    id: "msg-1",
                    role: "assistant",
                    botId: "bot-1",
                    runId: "run-1",
                    conversationId: "conversation-1",
                    blocks: [
                      {
                        id: "file",
                        kind: "file",
                        artifactId: "file-1",
                        name: "result.md",
                        mediaType: "text/markdown",
                      },
                      {id:"widget:cv_synthetic",kind:"widget",docId:"cv_synthetic",sessionKey:"synthetic",title:"交互图表"},
                    ],
                    createdAt: 1,
                    updatedAt: 1,
                    final: true,
                  },
                ],
              }
            : path === "/api/tasks/task-1"
              ? { run: { id: "run-1", taskId: "task-1", state: "waiting", createdAt: 1 } }
              : path === "/api/files/file-1" || path.includes("/attachments/")
                ? {
                    id: "file-1",
                    botId: "bot-1",
                    conversationId: "conversation-1",
                    name: "result.md",
                    mediaType: "text/markdown",
                    bytes: 6,
                    createdAt: 1,
                  }
                : {};
      return new Response(JSON.stringify(value), {
        status: path.endsWith("/cancel") && failCancel ? 500 : 200,
      });
    }),
  );
});

it("routes the legacy workspace panel to the selected Bot's local workspace", async () => {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockResolvedValueOnce(Response.json([
    { path: "projects/demo/result.txt", kind: "file", size: 16 },
  ]));
  await expect(localRpc("computer.files", {
    botId: "bot-a", path: "bots/bot-a/projects/demo",
  })).resolves.toEqual([{ path: "bots/bot-a/projects/demo/result.txt", kind: "file", size: 16 }]);
  expect(new URL(String(fetchMock.mock.calls.at(-1)?.[0])).pathname)
    .toBe("/api/bots/bot-a/workspace-files");

  fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
  await localRpc("computer.fileAction", {
    botId: "bot-a", path: "bots/bot-a/projects/demo/result.txt", action: "reveal",
  });
  expect(new URL(String(fetchMock.mock.calls.at(-1)?.[0])).pathname)
    .toBe("/api/bots/bot-a/workspace-files/action");
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)))
    .toEqual({ path: "projects/demo/result.txt", action: "reveal" });
});
afterEach(() => {
  forgetConnection();
  vi.unstubAllGlobals();
});

it("preserves native waiting/run/question identities and actual file size in the original snapshot contract", async () => {
  const snapshot = ThreadSnapshotSchema.parse(await localRpc("threads.get", { botId: "bot-1" }));
  expect(snapshot.cursor).toBe(37);
  expect(snapshot.run?.status).toBe("waiting_input");
  expect(snapshot.messages[0]?.runId).toBe("run-1");
  expect(snapshot.messages[0]?.blocks[0]).toMatchObject({ kind: "file", size: 42 });
  expect(snapshot.messages[0]?.blocks[1]).toMatchObject({kind:"text",preview:{blockId:"widget:cv_synthetic",title:"交互图表"}});
  expect(snapshot.messages[1]).toMatchObject({
    id: prompt.id,
    runId: "run-1",
    blocks: [{ kind: "ask", actions: [{ id: "local", label: "本机文件" }], status: "pending" }],
  });
});

it.each(["threads.fileInfo", "threads.filePreview", "threads.fileAction"])(
  "rejects a source path in %s without requesting a path as an artifact ID",
  async (method) => {
    await expect(localRpc(method, {
      botId: "bot-1", messageId: "msg-1", path: "/source.xlsx", action: "open",
    })).rejects.toThrow("这条消息没有交付该文件");
    expect(calls.some((call) => call.path.startsWith("/api/files/"))).toBe(false);
  },
);

it.each(["threads.fileInfo", "threads.filePreview", "threads.fileAction"])(
  "does not borrow another reply's delivered file in %s",
  async (method) => {
    await expect(localRpc(method, {
      botId: "bot-1", messageId: "other-message", path: "file-1", action: "open",
    })).rejects.toThrow("这条消息没有交付该文件");
    expect(calls.some((call) => call.path.startsWith("/api/files/"))).toBe(false);
  },
);

it("requires a message identity before looking up message files", async () => {
  await expect(localRpc("threads.fileInfo", { botId: "bot-1", path: "file-1" }))
    .rejects.toThrow("缺少消息标识");
  expect(calls.some((call) => call.path.startsWith("/api/files/"))).toBe(false);
});

it("reads real metadata and previews only the artifact delivered by the selected message", async () => {
  await expect(localRpc("threads.fileInfo", {
    botId: "bot-1", messageId: "msg-1", path: "/tasks/result.md",
  })).resolves.toEqual({ path: "/tasks/result.md", name: "result.md", size: 6 });
  await expect(localRpc("threads.filePreview", {
    botId: "bot-1", messageId: "msg-1", path: "file-1",
  })).resolves.toEqual({ name: "result.md", text: "交付" });
  await expect(localRpc("threads.fileAction", {
    botId: "bot-1", messageId: "msg-1", path: "file-1", action: "reveal",
  })).resolves.toEqual({ ok: true });
  expect(calls.filter((call) => call.path.startsWith("/api/files/")).map((call) => call.path))
    .toEqual(["/api/files/file-1", "/api/files/file-1", "/api/files/file-1", "/api/files/file-1/action"]);
});

it("answers the exact interaction with the native resolution and field identities", async () => {
  expect(
    await localRpc("threads.answer", {
      botId: "bot-1",
      messageId: prompt.id,
      runId: "run-1",
      answer: "local",
    }),
  ).toEqual({ ok: true });
  expect(calls.at(-1)).toMatchObject({
    path: "/api/tasks/task-1/interactions/question%3Aone/resolve",
    body: { resolutionId: expect.any(String), answers: { target: ["local"] } },
  });
  await expect(
    localRpc("threads.answer", { messageId: "different", runId: "run-1", answer: "local" }),
  ).rejects.toThrow();
});

it("maps native credential prompts to masked asks and submits only through the credential route", async () => {
  Object.assign(prompt, { secureInput: { name: "EXAMPLE_KEY", allowedHosts: ["api.example.test"] } });
  try {
    const snapshot = ThreadSnapshotSchema.parse(await localRpc("threads.get", { botId: "bot-1" }));
    expect(snapshot.messages[1]?.blocks[0]).toMatchObject({ input: "secret", text: "EXAMPLE_KEY" });
    await localRpc("threads.answer", {
      botId: "bot-1", messageId: prompt.id, runId: "run-1", answer: "fake-sensitive-value", clientNonce: "secure-one",
    });
    expect(calls.at(-1)).toEqual({
      path: "/api/tasks/task-1/interactions/question%3Aone/credential",
      body: { resolutionId: "secure-one", value: "fake-sensitive-value" },
    });
    expect(calls.filter((call) => call.path.endsWith("/resolve"))).toHaveLength(0);
  } finally { Reflect.deleteProperty(prompt, "secureInput"); }
});

it("maps arbitrary credential fields to the declared connection keys and supports cancellation", async () => {
  Object.assign(prompt, { secureInput: { name: "notes", allowedHosts: [], connection: {
    name: "notes", target: "env", fields: [
      { key: "EXAMPLE_ID", label: "Client ID" }, { key: "EXAMPLE_KEY", label: "API Key" },
    ],
  } } });
  try {
    const snapshot = ThreadSnapshotSchema.parse(await localRpc("threads.get", { botId: "bot-1" }));
    expect(snapshot.messages[1]?.blocks[0]).toMatchObject({
      input: "secret", secureConnection: "notes", loginFields: ["Client ID", "API Key"],
    });
    await localRpc("threads.answer", {
      botId: "bot-1", messageId: prompt.id, runId: "run-1", answer: "",
      fields: [{ label: "Client ID", value: "fake-client", hidden: true }, { label: "API Key", value: "fake-key", hidden: true }],
    });
    expect(calls.at(-1)?.body).toEqual({ values: { EXAMPLE_ID: "fake-client", EXAMPLE_KEY: "fake-key" } });
    await localRpc("threads.answer", { botId: "bot-1", messageId: prompt.id, runId: "run-1", answer: "", dismiss: true });
    expect(calls.at(-1)?.body).toMatchObject({ cancel: true });
  } finally { Reflect.deleteProperty(prompt, "secureInput"); }
});

it("reports cancellation failure instead of claiming the task stopped", async () => {
  failCancel = true;
  await expect(localRpc("threads.stop", { botId: "bot-1" })).rejects.toThrow();
});

it("returns the original stop result fields", async () => {
  expect(await localRpc("threads.stop", { botId: "bot-1" })).toEqual({
    ok: true,
    cancelledRunCount: 1,
    cancelledPendingMessageCount: 0,
  });
});

it("adapts the original base64 attachment upload and full artifact download contracts", async () => {
  const created = ArtifactSchema.parse(
    await localRpc("artifacts.create", {
      botId: "bot-1",
      name: "result.md",
      mimeType: "text/markdown",
      contentBase64: "YWJj",
      clientNonce: "upload-one",
    }),
  );
  expect(created.id).toBe("file-1");
  expect(calls.at(-1)?.path).toBe("/api/conversations/conversation-1/attachments/upload-one");
  const artifact = ArtifactWithContentSchema.parse(
    await localRpc("artifacts.get", { artifactId: "file-1" }),
  );
  expect(artifact.name).toBe("result.md");
  expect(artifact.size).toBe(6);
  expect(
    new TextDecoder().decode(
      Uint8Array.from(atob(artifact.contentBase64), (char) => char.charCodeAt(0)),
    ),
  ).toBe("交付");
});

it.each(["draft:synthetic-1", "task-session-1"])("uploads an attachment into its own task session (%s)", async (sessionId) => {
  const nonce = "12345678-1234-4234-8234-123456789abc";
  const created: unknown[] = [];
  const uploads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/api/conversations" && init?.method === "POST") {
      created.push(JSON.parse(String(init.body)));
      return Response.json({ id: "task-session-1" });
    }
    if (path === "/api/snapshot") return Response.json({ bots: [{ id: "bot-1" }],
      conversations: [{ id: "task-session-1", kind: "private", botIds: ["bot-1"] }] });
    if (path.includes("/attachments/")) {
      uploads.push(path);
      return Response.json({ id: nonce, botId: "bot-1", conversationId: "task-session-1", name: "image.png",mediaType:"image/png",bytes:3,createdAt:1 });
    }
    throw new Error(`Unexpected request ${path}`);
  }));
  for (let attempt=0;attempt<2;attempt++) await localRpc("artifacts.create", { botId:"bot-1",taskSessionId:sessionId,draftTitle:"Independent task",name:"image.png",mimeType:"image/png",contentBase64:"YWJj",clientNonce:nonce });
  expect(uploads).toEqual(Array(2).fill(`/api/conversations/task-session-1/attachments/${nonce}`));
  expect(created).toEqual(sessionId.startsWith("draft:") ? Array(2).fill({kind:"private",botIds:["bot-1"],title:"Independent task",clientNonce:sessionId}) : []);
});

it("shows the local upload validation error rather than hiding the cause", async () => {
  vi.stubGlobal("fetch",vi.fn(async(input:string)=>{
    const path=new URL(input).pathname;
    if(path==="/api/snapshot")return Response.json({bots:[{id:"bot-1"}],conversations:[{id:"task-session-1",kind:"private",botIds:["bot-1"]}]});
    return Response.json({error:"File exceeds 25 MB"},{status:400});
  }));
  await expect(localRpc("artifacts.create",{botId:"bot-1",taskSessionId:"task-session-1",name:"image.png",mimeType:"image/png",contentBase64:"YWJj"})).rejects.toThrow("File exceeds 25 MB");
});

it("saves a first browser connection before the initial route discards its parameters", () => {
  forgetConnection();
  window.history.replaceState(
    null,
    "",
    "/?localOrigin=http%3A%2F%2F127.0.0.1%3A1234&localToken=synthetic",
  );
  expect(localConnected()).toBe(true);
  expect(window.location.search).toBe("");
  expect(JSON.parse(window.sessionStorage.getItem("livingbot.local-connection")!)).toEqual({
    origin: "http://127.0.0.1:1234",
    token: "synthetic",
  });
});

it("delivers stream frames immediately and exposes EOF for the existing reconnect loop", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'id: 38\r\ndata: {"cursor":38,"type":"tasks.changed","data":{}}\r\n\r\n',
                ),
              );
              controller.close();
            },
          }),
        ),
    ),
  );
  const events = openLocalThreadEvents(new AbortController().signal, 37);
  expect((await events.next()).value).toMatchObject({ cursor: 38, type: "tasks.changed" });
  await expect(events.next()).rejects.toThrow("事件连接已断开");
});

it("treats SSE comments as liveness without inventing a durable cursor", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
              controller.close();
            },
          }),
        ),
    ),
  );
  const events = openLocalThreadEvents(new AbortController().signal, 37);
  expect((await events.next()).value).toEqual({ cursor: 0, type: "heartbeat", data: {} });
  await events.return(undefined);
});

it("keeps original group contracts, member edits, native send identity and each running Bot's identity", async () => {
  const bots = ["bot-1", "bot-2", "bot-3"].map((id) => ({ id, name: id, agentId: id, createdAt: 1 }));
  let group = { id: "group-1", kind: "group", title: "项目群", botIds: ["bot-1", "bot-2"], createdAt: 1 };
  const seen: { path: string; method?: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    seen.push({ path, method: init?.method, body });
    if (path === "/api/conversations" && init?.method === "POST") group = { ...group, title: body.title, botIds: body.botIds };
    if (path === "/api/conversations/group-1" && init?.method === "PATCH") group = { ...group, ...body };
    const value = path === "/api/snapshot"
      ? { bots, conversations: [group], interactions: [], tasks: [
          { id: "task-1", botId: "bot-1", conversationId: group.id, status: "running" },
          { id: "task-2", botId: "bot-2", conversationId: group.id, status: "running" },
        ] }
      : path === "/api/conversations/group-1/messages"
        ? { cursor: 10, messages: [
            { id: "earlier", conversationId: group.id, role: "user", blocks: [], createdAt: 1 },
            { id: "group-input:stable-group-send", conversationId: group.id, role: "user", blocks: [], createdAt: 2 },
          ] }
        : path === "/api/group-submissions"
          ? { outcomes: [{ botId: "bot-1", accepted: true, task: { id: "task-1" } }] }
          : path.startsWith("/api/tasks/")
            ? { run: { id: `run-${path.split("/").at(-1)}`, state: "running", createdAt: 1 } }
            : group;
    return new Response(JSON.stringify(value));
  }));
  const created = GroupSchema.parse(await localRpc("groups.create", { name: "项目群", botIds: ["bot-1", "bot-2"] }));
  expect(created.members.map((member) => member.botId)).toEqual(["bot-1", "bot-2"]);
  expect(created.threadId).toBe(group.id);
  const updated = GroupSchema.parse(await localRpc("groups.update", {
    groupId: group.id, name: "改名", botIds: ["bot-1", "bot-3"],
    expectedBotIds: ["bot-1", "bot-2"], pinned: true,
  }));
  expect(updated.name).toBe("改名");
  expect(updated.pinned).toBe(true);
  expect(updated.members.map((member) => member.botId)).toEqual(["bot-1", "bot-3"]);
  const result = await localRpc("threads.send", { groupId: group.id, text: "执行任务", clientNonce: "stable-group-send" });
  expect(result).toMatchObject({ taskId: "task-1", runId: "run-task-1", seq: 1 });
  expect(seen.find((call) => call.path === "/api/group-submissions")?.body).toMatchObject({
    conversationId: group.id, botIds: ["bot-1", "bot-3"], submissionId: "stable-group-send",
  });
  expect(seen.some((call) => call.path.endsWith("/private-conversation"))).toBe(false);
  const snapshot = ThreadSnapshotSchema.parse(await localRpc("threads.get", { groupId: group.id }));
  expect(snapshot.activeRuns?.map((run) => run.botId)).toEqual(["bot-1", "bot-2"]);
});
