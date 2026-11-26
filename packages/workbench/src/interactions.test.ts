import assert from "node:assert/strict";
import test from "node:test";
import { Interactions } from "./interactions.ts";
import type { InteractionGateway } from "./interactions.ts";
import { WorkbenchStore } from "./store.ts";
import type { Interaction, Task } from "./contracts.ts";

function fixture() {
  const store = new WorkbenchStore(":memory:");
  const bot = store.createBot({ name: "Interactive Bot" });
  const conversation = store.privateConversation(bot.id);
  const { task, submission } = store.beginSubmission({
    submissionId: "interactive-input", conversationId: conversation.id, botId: bot.id, message: "Work",
  });
  store.acceptSubmission(submission.id, "interactive-run", 1);
  const calls: { method: string; params: unknown }[] = [];
  const gateway: InteractionGateway = {
    generation: 1,
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      return (method === "question.list" ? { questions: [] } : method === "exec.approval.list" ? [] : { status: "answered" }) as T;
    },
  };
  const interactions = new Interactions(store, gateway);
  const payload = {
    id: "question-one", sessionKey: submission.sessionKey, runId: "interactive-run",
    createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    questions: [{
      questionId: "target", header: "Target", question: "Choose a target",
      options: [{ label: "Local", value: "local" }, { label: "Preview", value: "preview" }],
    }],
  };
  return { store, task, submission, interactions, gateway, calls, payload };
}

test("question answer binds the original task, validates options and never starts a new turn", async () => {
  const f = fixture();
  f.interactions.frame({ event: "question.requested", payload: f.payload }, 1);
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "waiting");
  await assert.rejects(f.interactions.resolve("question:question-one", "wrong-task", { resolutionId: "r1", answers: { target: ["local"] } }), /belong/);
  assert.throws(() => f.interactions.resolve("question:question-one", f.task.id, { resolutionId: "invalid", answers: { target: ["unknown"] } }), /Invalid/);
  const answer = { resolutionId: "r1", answers: { target: ["local"] } };
  const result = await f.interactions.resolve("question:question-one", f.task.id, answer);
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answer, { answers: { target: ["local"] } });
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "running");
  await f.interactions.resolve("question:question-one", f.task.id, answer);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "question.resolve");
  await assert.rejects(f.interactions.resolve("question:question-one", f.task.id, { ...answer, answers: { target: ["preview"] } }), /conflicts/);
  f.store.close();
});

test("two questions keep a task waiting until both close; late requested events cannot reopen answers", async () => {
  const f = fixture();
  f.interactions.frame({ event: "question.requested", payload: f.payload }, 1);
  f.interactions.frame({ event: "question.requested", payload: { ...f.payload, id: "question-two" } }, 1);
  await f.interactions.resolve("question:question-one", f.task.id, { resolutionId: "r1", answers: { target: ["local"] } });
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "waiting");
  f.interactions.frame({ event: "question.resolved", payload: { id: "question-two", status: "expired" } }, 1);
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "running");
  f.interactions.frame({ event: "question.requested", payload: f.payload }, 1);
  assert.equal(f.store.get<Interaction>("interactions", "question:question-one")?.status, "answered");
  f.store.close();
});

test("approval uses allowed decisions, keeps uncertain answer identity and excludes secret prompts", async () => {
  const f = fixture();
  f.interactions.frame({ event: "exec.approval.requested", payload: {
    id: "approval-one", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    request: { sessionKey: f.submission.sessionKey, runId: "interactive-run", commandPreview: "Run a local command", allowedDecisions: ["allow-once", "deny"] },
  } }, 1);
  assert.throws(() => f.interactions.resolve("approval:approval-one", f.task.id, { resolutionId: "r1", decision: "allow-always" }), /not available/);
  f.gateway.request = async () => { throw new Error("Reply lost"); };
  await assert.rejects(f.interactions.resolve("approval:approval-one", f.task.id, { resolutionId: "r1", decision: "deny" }), /Reply lost/);
  assert.equal(f.store.get<Interaction>("interactions", "approval:approval-one")?.status, "answering");
  f.interactions.observe({ type: "exit", generation: 1, code: 0, signal: null });
  assert.equal(f.store.get<Interaction>("interactions", "approval:approval-one")?.status, "unavailable");
  f.interactions.frame({ event: "question.requested", payload: {
    ...f.payload, questions: [{ ...f.payload.questions[0], isSecret: true, secretStore: { name: "SECRET" } }],
  } }, 1);
  assert.equal(f.store.get("interactions", "question:question-one"), undefined);
  f.store.close();
});

test("recovery imports only exact known-run prompts and never guesses from session activity", async () => {
  const f = fixture();
  f.gateway.request = async <T>(method: string) => (method === "question.list"
    ? { questions: [f.payload, { ...f.payload, id: "unowned", runId: "unowned-run" }] } : []) as T;
  await f.interactions.recover();
  assert.equal(f.store.list("interactions").length, 1);
  assert.equal(f.store.pendingFrames("unowned-run").length, 1);
  f.store.close();
});

test("store-bound native secrets use a separate route and retain only the stored marker", async () => {
  const f = fixture();
  try {
    const events: unknown[] = [];
    f.store.on("event", (event) => events.push(event));
    const payload = { ...f.payload, questions: [{
      questionId: "secret_value", question: "Provide a credential", header: "API key", options: [],
      isSecret: true, secretStore: { name: "EXAMPLE_KEY", kind: "secret", allowedHosts: ["api.example.test"] },
    }] };
    f.interactions.frame({ event: "question.requested", payload }, 1);
    const id = "question:question-one";
    assert.equal(f.store.get<Interaction>("interactions", id)?.secureInput?.name, "EXAMPLE_KEY");
    await assert.rejects(f.interactions.resolve(id, f.task.id, {
      resolutionId: "ordinary", answers: { secret_value: ["fake-sensitive-value"] },
    }), /secure/);
    await assert.rejects(f.interactions.resolveSecret(id, "wrong", "secure", "fake-sensitive-value"), /belong/);
    f.gateway.request = async <T>(method: string, params: unknown) => {
      assert.equal(method, "question.resolve");
      assert.equal((params as { answers: { answers: Record<string, string[]> } }).answers.answers.secret_value[0], "fake-sensitive-value");
      return { status: "answered", answers: { answers: { secret_value: ["stored"] } } } as T;
    };
    const result = await f.interactions.resolveSecret(id, f.task.id, "secure", "fake-sensitive-value");
    assert.deepEqual(result.answer, { answers: { secret_value: ["stored"] } });
    assert.equal(result.status, "answered");
    await f.interactions.resolveSecret(id, f.task.id, "secure", "other-value");
    const persisted = JSON.stringify([events, f.store.snapshot(), f.store.list("settings")]);
    assert.ok(!persisted.includes("fake-sensitive-value"));
    assert.ok(!persisted.includes("other-value"));
    f.interactions.frame({ event: "question.resolved", payload: {
      id: "question-one", status: "answered", answers: { answers: { secret_value: ["fake-sensitive-value"] } },
    } }, 1);
    assert.ok(!JSON.stringify(f.store.snapshot()).includes("fake-sensitive-value"));
  } finally { f.store.close(); }
});

test("native secret failure does not echo input, and a matching terminal receipt confirms a lost reply", async () => {
  const f = fixture();
  try {
    f.interactions.frame({ event: "question.requested", payload: { ...f.payload, questions: [{
      questionId: "secret_value", question: "Key", options: [], isSecret: true,
      secretStore: { name: "EXAMPLE_KEY", kind: "secret", allowedHosts: [] },
    }] } }, 1);
    let confirmed = false;
    f.gateway.request = async <T>(method: string) => {
      if (method === "question.resolve") throw new Error("fake-sensitive-value");
      return { status: confirmed ? "answered" : "pending", resolutionId: "secure",
        answers: { answers: { secret_value: ["stored"] } } } as T;
    };
    await assert.rejects(f.interactions.resolveSecret("question:question-one", f.task.id, "secure", "fake-sensitive-value"),
      (error: Error) => !error.message.includes("fake-sensitive-value"));
    const current = f.store.get<Interaction>("interactions", "question:question-one")!;
    f.interactions.frame({ event: "question.requested", payload: {
      ...f.payload, questions: [{
        questionId: "secret_value", question: "Key", options: [], isSecret: true,
        secretStore: { name: "EXAMPLE_KEY", kind: "secret", allowedHosts: [] },
      }],
    } }, 1);
    assert.equal(f.store.get<Interaction>("interactions", current.id)?.resolutionId, "secure");
    confirmed = true;
    assert.equal((await f.interactions.resolveSecret("question:question-one", f.task.id, "secure", "fake-sensitive-value")).status, "answered");
  } finally { f.store.close(); }
});

test("a native secret resolution without the stored marker is unavailable and never retains its value", () => {
  const f = fixture();
  try {
    f.interactions.frame({ event: "question.requested", payload: { ...f.payload, questions: [{
      questionId: "secret_value", question: "Key", options: [], isSecret: true,
      secretStore: { name: "EXAMPLE_KEY", kind: "secret", allowedHosts: [] },
    }] } }, 1);
    f.interactions.frame({ event: "question.resolved", payload: {
      id: "question-one", status: "answered", answers: { answers: { secret_value: ["fake-sensitive-value"] } },
    } }, 1);
    assert.equal(f.store.get<Interaction>("interactions", "question:question-one")?.status, "unavailable");
    assert.ok(!JSON.stringify(f.store.snapshot()).includes("fake-sensitive-value"));
  } finally { f.store.close(); }
});

test("approval projects only native display metadata and retains it after the decision", async () => {
  const f = fixture();
  const approval = {
    command: "example --exact", host: "gateway", cwd: "/example/workspace",
    warningText: "Native warning",
    commandAnalysis: { commandCount: 1, nestedCommandCount: 0,
      riskKinds: ["inline-eval", "future-native-risk"], warningLines: ["Contains inline-eval: example"] },
  };
  try {
    f.interactions.frame({ event: "exec.approval.requested", payload: {
      id: "metadata", expiresAtMs: Date.now() + 60_000,
      request: {
        ...approval, taskTitle: "not-for-ui", commandPreview: "native preview", allowedDecisions: ["allow-once", "deny"],
        sessionKey: f.submission.sessionKey, runId: "interactive-run",
        env: { SECRET: "not-for-ui" }, systemRunBinding: { opaque: "not-for-ui" },
      },
    } }, 1);
    const prompt = f.store.get<Interaction>("interactions", "approval:metadata")!;
    assert.equal(prompt.title, "native preview");
    assert.deepEqual(prompt.approval, { ...approval, taskTitle: f.task.title });
    assert.ok(!JSON.stringify(prompt).includes("not-for-ui"));
    const result = await f.interactions.resolve(prompt.id, f.task.id, { resolutionId: "metadata-answer", decision: "deny" });
    assert.deepEqual(result.approval, { ...approval, taskTitle: f.task.title });
    assert.equal(result.status, "answered");
    assert.equal(f.calls[0].method, "exec.approval.resolve");
  } finally { f.store.close(); }
});

test("absent or malformed native display analysis does not invent a summary or discard the approval", () => {
  const f = fixture();
  try {
    f.interactions.frame({ event: "exec.approval.requested", payload: {
      id: "malformed", request: {
        sessionKey: f.submission.sessionKey, runId: "interactive-run", command: "example",
        cwd: 42, warningText: {}, commandAnalysis: {
          commandCount: -1, nestedCommandCount: "one", riskKinds: ["source", 42],
          warningLines: [null, "Native warning"], semanticSummary: "invented",
        },
      },
    } }, 1);
    assert.deepEqual(f.store.get<Interaction>("interactions", "approval:malformed")?.approval, {
      taskTitle: f.task.title, command: "example", commandAnalysis: { riskKinds: ["source"], warningLines: ["Native warning"] },
    });
    f.interactions.frame({ event: "exec.approval.requested", payload: {
      id: "legacy", request: { sessionKey: f.submission.sessionKey, runId: "interactive-run", commandPreview: "example" },
    } }, 1);
    assert.deepEqual(f.store.get<Interaction>("interactions", "approval:legacy")?.approval, { taskTitle: f.task.title });
  } finally { f.store.close(); }
});

test("lost question acknowledgment is confirmed only by the native matching resolution identity", async () => {
  const f = fixture();
  f.interactions.frame({ event: "question.requested", payload: f.payload }, 1);
  let nativeResolution = "different-answer";
  f.gateway.request = async <T>(method: string) => {
    if (method === "question.resolve") throw new Error("Acknowledgment lost");
    assert.equal(method, "question.waitAnswer");
    return { status: "answered", resolutionId: nativeResolution, answers: { answers: { target: ["local"] } } } as T;
  };
  const answer = { resolutionId: "our-answer", answers: { target: ["local"] } };
  await assert.rejects(f.interactions.resolve("question:question-one", f.task.id, answer), /lost/);
  nativeResolution = "our-answer";
  const result = await f.interactions.resolve("question:question-one", f.task.id, answer);
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answer?.answers, { target: ["local"] });
  f.store.close();
});

test("reconnect recovers a terminal question and cannot retire a prompt arriving during the list request", async () => {
  const f = fixture();
  f.interactions.frame({ event: "question.requested", payload: f.payload }, 1);
  f.gateway.request = async <T>(method: string) => {
    if (method === "question.list") {
      f.interactions.frame({ event: "question.requested", payload: { ...f.payload, id: "arrived-during-list" } }, 1);
      return { questions: [] } as T;
    }
    if (method === "exec.approval.list") return [] as T;
    assert.equal(method, "question.waitAnswer");
    return { status: "answered", answers: { answers: { target: ["local"] } } } as T;
  };
  await f.interactions.recover();
  assert.equal(f.store.get<Interaction>("interactions", "question:question-one")?.status, "answered");
  assert.equal(f.store.get<Interaction>("interactions", "question:arrived-during-list")?.status, "pending");
  assert.equal(f.store.get<Task>("tasks", f.task.id)?.status, "waiting");
  f.store.close();
});
