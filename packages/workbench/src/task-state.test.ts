import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "./contracts.ts";
import { primaryBotTask, taskActivity } from "./task-state.ts";

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
  id, botId: "atlas", conversationId: "private-atlas", reportConversationId: "private-atlas",
  title: id, status, createdAt: 1, updatedAt: 1, ...extra,
});

test("a waiting group task stays discoverable beside older services and newer queued inputs", () => {
  const background = task("service", "completed", { processes: [{
    id: "service", runId: "run", sessionKey: "session", toolCallId: "call", processId: "process",
    startedAt: 1, status: "running",
  }] });
  const waiting = task("approval", "waiting", { conversationId: "group", updatedAt: 2 });
  const queued = task("followup", "queued", { updatedAt: 3 });
  const running = task("other-private", "running", { updatedAt: 4 });
  const otherBot = task("other-bot", "waiting", { botId: "moss", updatedAt: 9 });
  const tasks = [background, queued, waiting, running, otherBot];
  assert.equal(primaryBotTask(tasks, "atlas"), waiting);
  assert.equal(primaryBotTask(tasks, "atlas")?.conversationId, "group");
  assert.equal(primaryBotTask(tasks.filter((item) => item !== waiting), "atlas"), running);
  assert.equal(taskActivity(primaryBotTask([background], "atlas")!), "background");
  assert.equal(primaryBotTask(tasks, "moss"), otherBot);
  assert.equal(primaryBotTask(tasks, "absent"), undefined);
});

test("ended work clears Bot activity and equal-priority selection follows the latest fact without reordering input", () => {
  const older = task("older", "running", { updatedAt: 2 });
  const newer = task("newer", "running", { updatedAt: 3 });
  const tasks = [older, newer];
  assert.equal(primaryBotTask(tasks, "atlas"), newer);
  assert.deepEqual(tasks.map((item) => item.id), ["older", "newer"]);
  assert.equal(primaryBotTask([
    task("done", "completed"), task("stopped", "cancelled"), task("failed", "failed"),
    task("closed-service", "completed", { processes: [{
      id: "service", runId: "run", sessionKey: "session", toolCallId: "call", processId: "process",
      startedAt: 1, status: "killed",
    }] }),
  ], "atlas"), undefined);
});
