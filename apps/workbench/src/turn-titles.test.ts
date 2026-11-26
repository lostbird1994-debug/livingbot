import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { defaultConnection, nameTurnTitles } from "./turn-titles.ts";

const config = {
  agents: { defaults: { model: { primary: "hon-maas/deepseek" } } },
  models: {
    providers: {
      "hon-maas": {
        baseUrl: "https://example.test/v1/",
        api: "openai-completions",
        apiKey: "sk-test",
        models: [{ id: "deepseek" }],
      },
    },
  },
};

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    conversationId: "c1",
    role: "user",
    blocks: [{ kind: "text", text: "" }],
    final: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Message;
}

function storeStub(rows: Message[]) {
  const written: Message[] = [];
  const store = {
    find: () => rows,
    get: (kind: string, id: string) =>
      kind === "messages" ? rows.find((row) => row.id === id) : undefined,
    put: (_kind: string, value: Message) => {
      written.push(value);
      return value;
    },
  } as unknown as WorkbenchStore;
  return { store, written };
}

const reply = (id: string, text: string) =>
  message({
    id,
    role: "assistant",
    createdAt: 2,
    blocks: [{ kind: "text", text }],
  } as unknown as Message);

test("reads the model the kernel runs on, from its own configuration", () => {
  const connection = defaultConnection(config as unknown as Record<string, unknown>);
  assert.equal(connection?.model, "deepseek");
  assert.equal(connection?.baseUrl, "https://example.test/v1/");
  assert.equal(connection?.apiKey, "sk-test");
  assert.equal(defaultConnection({}), null);
});

test("names a turn from the person's words and the reply, and stores it", async () => {
  const rows = [
    message({
      id: "u1",
      blocks: [{ kind: "text", text: "请整理虚构花园的浇水计划" }],
    } as unknown as Message),
    reply("a1", "示例花园周一浇水，周三检查土壤。"),
  ];
  const { store, written } = storeStub(rows);
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: string, init: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init.body ?? "{}") });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "「示例花园计划」" } }] }),
    };
  }) as unknown as typeof fetch;

  const named = await nameTurnTitles(
    { store, conversationId: "c1", messageIds: ["u1"], fetcher },
    config as unknown as Record<string, unknown>,
  );

  assert.deepEqual(named, [{ id: "u1", title: "示例花园计划" }]);
  assert.equal(written[0]?.turnTitle, "示例花园计划");
  assert.equal(calls[0]?.url, "https://example.test/v1/chat/completions");
  const body = calls[0]?.body as { model: string; messages: { content: string }[] };
  assert.equal(body.model, "deepseek");
  // The reply's opening is part of the excerpt the model names from.
  assert.match(body.messages[1]!.content, /周三检查土壤/);
});

test("leaves a turn alone when the provider fails or the turn already has a name", async () => {
  const rows = [
    message({ id: "u1", blocks: [{ kind: "text", text: "问题一" }] } as unknown as Message),
    message({
      id: "u2",
      turnTitle: "已有名字",
      createdAt: 3,
      blocks: [{ kind: "text", text: "问题二" }],
    } as unknown as Message),
  ];
  const { store, written } = storeStub(rows);
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const named = await nameTurnTitles(
    { store, conversationId: "c1", messageIds: ["u1", "u2"], fetcher: failing },
    config as unknown as Record<string, unknown>,
  );
  assert.deepEqual(named, []);
  assert.equal(written.length, 0);
});

for (const change of ["deleted", "edited", "moved", "already named", "metadata"] as const) {
  test(`a delayed title respects a message that was ${change}`, async () => {
    const rows = [message({ id: "u1", blocks: [{ kind: "text", text: "示例花园计划" }] })];
    const { store, written } = storeStub(rows);
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const naming = nameTurnTitles(
      {
        store,
        conversationId: "c1",
        messageIds: ["u1"],
        fetcher: (() => response) as typeof fetch,
      },
      config,
    );
    const original = rows[0]!;
    if (change === "deleted") rows.splice(0);
    if (change === "edited")
      rows[0] = { ...original, blocks: [{ kind: "text", text: "改为示例书架计划" }] };
    if (change === "moved") rows[0] = { ...original, conversationId: "c2" };
    if (change === "already named") rows[0] = { ...original, turnTitle: "用户的新标题" };
    if (change === "metadata") rows[0] = { ...original, final: false };
    finish(new Response(JSON.stringify({ choices: [{ message: { content: "花园计划" } }] })));
    const named = await naming;
    if (change === "metadata") {
      assert.equal(written.length, 1);
      assert.equal(written[0]?.final, false);
      assert.equal(written[0]?.turnTitle, "花园计划");
    } else {
      assert.deepEqual(named, []);
      assert.deepEqual(written, []);
    }
  });
}
