import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { HistoryPage, Submission } from "../../kernel-runtime/src/contracts.ts";
import type { Message, ProductEvent, ResultNotification, Task } from "./contracts.ts";
import { EngineProjector } from "./projector.ts";
import { WorkbenchStore } from "./store.ts";
import { WorkbenchService } from "./service.ts";

class ResultKernel extends EventEmitter {
  generation = 1;
  phase = "ready";
  async request<T>(): Promise<T> { return [] as T; }
  async send(input: Submission) { return { runId: input.idempotencyKey, status: "started" }; }
  async recoverHistory(): Promise<HistoryPage> { return { messages: [] }; }
  async abort() { return { aborted: true }; }
}

function fixture(path = ":memory:", privateReport = false) {
  const store = new WorkbenchStore(path);
  const bot = store.createBot({ name: "Atlas" });
  const destination = store.privateConversation(bot.id);
  const origin = privateReport ? store.createConversation("group", [bot.id], "Synthetic group") : destination;
  const { task, submission } = store.beginSubmission({
    submissionId: "synthetic-result", botId: bot.id, conversationId: origin.id, message: "Synthetic work",
    reportConversationId: destination.id,
  });
  store.acceptSubmission(submission.id, "synthetic-run", 1);
  const projector = new EngineProjector(store);
  function frame(state: string, extra: Record<string, unknown> = {}) {
    projector.frame(1, { event: "chat", payload: {
      runId: "synthetic-run", sessionKey: submission.sessionKey, state, ...extra,
    } });
  }
  return { store, bot, origin, destination, task, submission, projector, frame };
}

test("result notification and its exact private reply commit together, replay does not duplicate or unread it", () => {
  const f = fixture(":memory:", true);
  try {
    let observed: ResultNotification | undefined;
    f.store.on("event", (event: ProductEvent) => {
      if (event.type !== "notifications.changed") return;
      observed = event.data as ResultNotification;
      const reply = f.store.get<Message>("messages", observed.messageId);
      assert.equal(reply?.final, true);
      assert.equal(reply?.conversationId, f.destination.id);
      assert.equal(f.store.get<Task>("tasks", observed.taskId)?.status, "completed");
    });
    f.frame("final", { message: { content: "Synthetic completed report" } });
    assert.equal(observed?.conversationId, f.destination.id);
    assert.equal(observed?.messageId, `report:${f.task.id}`);
    const read = f.store.readNotification(observed!.id);
    const cursor = f.store.cursor();
    f.frame("final", { message: { content: "Synthetic completed report" } });
    assert.deepEqual(f.store.readNotification(read.id), read);
    assert.equal(f.store.cursor(), cursor);
    assert.equal(f.store.snapshot().notifications.length, 1);
  } finally { f.store.close(); }
});

test("lifecycle end, interrupted restart, stop and empty steering acknowledgments never announce a result", () => {
  for (const reason of ["lifecycle", "restart", "cancel", "steer", "empty"]) {
    const f = fixture();
    try {
      if (reason === "lifecycle") f.projector.frame(1, { event: "agent", payload: {
        runId: "synthetic-run", sessionKey: f.submission.sessionKey, stream: "lifecycle", data: { phase: "end" },
      } });
      else if (reason === "restart") f.frame("aborted", { stopReason: "restart" });
      else if (reason === "cancel") f.frame("aborted");
      else {
        if (reason === "steer") f.store.put("submissions", { ...f.submission, queueMode: "steer" });
        f.frame("final");
      }
      assert.deepEqual(f.store.snapshot().notifications, [], reason);
    } finally { f.store.close(); }
  }
});

test("failure notification is retained with its read state across database reopen", () => {
  const base = resolve("local/test-fixtures");
  mkdirSync(base, { recursive: true });
  const path = join(mkdtempSync(join(base, "result-notifications-")), "workbench.sqlite");
  const f = fixture(path);
  f.frame("error", { errorMessage: "Synthetic provider failure" });
  const notification = f.store.snapshot().notifications[0];
  assert.equal(notification.outcome, "failed");
  assert.equal(notification.messageId, "engine:synthetic-run");
  const read = f.store.readNotification(notification.id);
  f.store.close();
  const reopened = new WorkbenchStore(path);
  try {
    assert.deepEqual(reopened.snapshot().notifications, [read]);
    assert.throws(() => reopened.readNotification("unknown"), /Unknown notification/);
    assert.equal(reopened.get<Message>("messages", notification.messageId)?.final, true);
  } finally { reopened.close(); }
});

test("a failed result transaction leaves no result, notice or published event", () => {
  const f = fixture();
  try {
    const before = f.store.cursor();
    assert.throws(() => f.store.transaction(() => {
      f.frame("final", { message: { content: "Rolled back" } });
      throw new Error("Synthetic write failure");
    }));
    assert.equal(f.store.cursor(), before);
    assert.deepEqual(f.store.snapshot().notifications, []);
    assert.equal(f.store.get<Message>("messages", "engine:synthetic-run"), undefined);
  } finally { f.store.close(); }
});

test("native cron commits hydrate the exact task before or after its empty terminal and retain tool blocks", () => {
  for (const order of ["commit-first", "terminal-first"]) {
    const f = fixture();
    const kernel = new ResultKernel();
    const service = new WorkbenchService(f.store, kernel);
    try {
      f.store.put("tasks", { ...f.task, routine: {
        id: "synthetic-schedule", jobId: "native-job", sessionId: "physical-session",
        occurrenceId: "cron:native-job:123", runId: "synthetic-run",
      } });
      f.projector.frame(1, { event: "agent", payload: {
        runId: "synthetic-run", sessionKey: f.submission.sessionKey, stream: "tool",
        data: { toolCallId: "read-source", name: "read", phase: "result" },
      } });
      const commit = { type: "frame" as const, generation: 1, frame: { event: "session.message", payload: {
        sessionKey: f.submission.sessionKey, sessionId: "physical-session", messageId: "native-result",
        message: {
          role: "assistant", api: "openclaw-transcript", provider: "openclaw", model: "automation-result",
          stopReason: "stop", content: [{ type: "text", text: "Committed native result." }],
          openclawAutomation: { kind: "cron", jobId: "native-job", runId: "cron:native-job:123" },
        },
      } } };
      if (order === "terminal-first") f.frame("final");
      else kernel.emit("observation", commit);
      assert.equal(f.store.snapshot().notifications.length, 0, "Neither a tool-only terminal nor an unconfirmed model result is delivery");
      if (order === "terminal-first") kernel.emit("observation", commit);
      else f.frame("final");
      const notice = f.store.snapshot().notifications[0];
      assert.equal(notice.taskId, f.task.id);
      assert.equal(notice.messageId, "engine:synthetic-run");
      assert.deepEqual(f.store.get<Message>("messages", notice.messageId)?.blocks.map((block) => block.kind), ["tool", "text"]);
      assert.equal(f.store.messages(f.origin.id).filter((message) => message.role === "assistant").length, 1);
      const cursor = f.store.cursor();
      kernel.emit("observation", commit);
      assert.equal(f.store.cursor(), cursor);
    } finally { service.detach(); f.store.close(); }
  }
});

test("a cron result cannot claim a different job, occurrence or physical session", () => {
  for (const mismatch of ["job", "occurrence", "session"]) {
    const f = fixture();
    const kernel = new ResultKernel();
    const service = new WorkbenchService(f.store, kernel);
    try {
      f.store.put("tasks", { ...f.task, routine: {
        id: "synthetic-schedule", jobId: "native-job", sessionId: "physical-session",
        occurrenceId: "cron:native-job:123", runId: "synthetic-run",
      } });
      f.frame("final");
      kernel.emit("observation", { type: "frame", generation: 1, frame: { event: "session.message", payload: {
        sessionKey: f.submission.sessionKey, sessionId: mismatch === "session" ? "other-session" : "physical-session",
        messageId: "foreign-result", message: {
          role: "assistant", api: "openclaw-transcript", provider: "openclaw", model: "automation-result",
          stopReason: "stop", content: "Unrelated native result",
          openclawAutomation: {
            kind: "cron", jobId: mismatch === "job" ? "foreign-job" : "native-job",
            runId: mismatch === "occurrence" ? "cron:native-job:124" : "cron:native-job:123",
          },
        },
      } } });
      assert.equal(f.store.snapshot().notifications.length, 0);
      assert.deepEqual(f.store.get<Message>("messages", "engine:synthetic-run")?.blocks, []);
    } finally { service.detach(); f.store.close(); }
  }
});

test("native quiet cron commits remain silent before and after the terminal, including replay", () => {
  for (const text of ["", " \n", "NO_REPLY"]) for (const order of ["commit-first", "terminal-first"]) {
    const f = fixture();
    const kernel = new ResultKernel();
    const service = new WorkbenchService(f.store, kernel);
    try {
      f.store.put("tasks", { ...f.task, routine: { id: "schedule", jobId: "job", sessionId: "session",
        occurrenceId: "cron:job:123", runId: "synthetic-run" } });
      const commit = { type: "frame" as const, generation: 1, frame: { event: "session.message", payload: {
        sessionKey: f.submission.sessionKey, sessionId: "session", messageId: "quiet-commit",
        message: { role: "assistant", api: "openclaw-transcript", provider: "openclaw", model: "automation-result",
          stopReason: "stop", content: text, openclawAutomation: { kind: "cron", jobId: "job", runId: "cron:job:123" } },
      } } };
      f.store.markRead(f.origin.id);
      if (order === "terminal-first") f.frame("final"); else kernel.emit("observation", commit);
      if (order === "terminal-first") kernel.emit("observation", commit); else f.frame("final");
      assert.equal(f.store.get<Task>("tasks", f.task.id)!.status, "completed");
      assert.equal(f.store.messages(f.origin.id).filter(m => m.role === "assistant").length, 0);
      assert.equal(f.store.readState(f.origin.id).unread, false);
      assert.equal(f.store.snapshot().notifications.length, 0);
      const cursor = f.store.cursor();
      kernel.emit("observation", commit);
      assert.equal(f.store.cursor(), cursor);
    } finally { service.detach(); f.store.close(); }
  }
});
