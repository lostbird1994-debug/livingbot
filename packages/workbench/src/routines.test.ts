import assert from "node:assert/strict";
import test from "node:test";
import type { RoutineDefinition, NativeRoutine, RoutineOutcome, RoutineProvider } from "../../kernel-runtime/src/routines.ts";
import { WorkbenchStore } from "./store.ts";
import { Routines } from "./routines.ts";
import type { NativeScheduledRun } from "./routines.ts";
import type { Run, Task } from "./contracts.ts";
import { nativeTask } from "./authority.ts";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

function fixture(path = ":memory:") {
  const store = new WorkbenchStore(path);
  const bot = store.createBot({ name: "Atlas", agentId: "atlas" });
  const conversation = store.privateConversation(bot.id);
  let native: NativeRoutine;
  let creates = 0;
  let changes = 0;
  let loseCreation = false;
  const provider: RoutineProvider = {
    async create(definition: RoutineDefinition) {
      creates++;
      native ??= { ...definition, id: "native-job", revision: "rev-one", enabled: true };
      if (loseCreation) { loseCreation = false; throw new Error("Synthetic lost acknowledgment"); }
      return native;
    },
    async get() { return native; },
    async setEnabled(_id, revision, enabled) {
      assert.equal(revision, native.revision);
      changes++;
      native = { ...native, revision: `rev-${changes + 1}`, enabled }; return native;
    },
    async update(_id, revision, changes) {
      assert.equal(revision, native.revision);
      return native = { ...native, ...changes, revision: "edited-revision" };
    },
    async remove() {},
    async runNow() { return { runId: null }; },
    async history() {
      return { entries: [{
        occurrenceKey: "run:once", runId: "once", jobId: "native-job", status: "ok", completion: "unknown", delivery: "unknown", timestamp: 1,
      } as RoutineOutcome], hasMore: false };
    },
  };
  const routines = new Routines(store, provider);
  const input = {
    id: "create-one", botId: bot.id, conversationId: conversation.id,
    name: "Daily summary", message: "Synthetic task", schedule: { kind: "every" as const, everyMs: 86_400_000 },
  };
  return {
    store, provider, routines, input, counts: () => ({ creates, changes }),
    loseCreation() { loseCreation = true; }, native: () => native,
    changeNative(value: Partial<NativeRoutine>) { native = { ...native, ...value }; },
  };
}
test("pending schedules retain their request through uncertain creation and recovery without another visible task", async () => {
  const f = fixture();
  f.loseCreation();
  await assert.rejects(f.routines.create(f.input), /lost acknowledgment/);
  assert.equal(f.routines.get(f.input.id).state, "pending");
  await f.routines.reconcile();
  assert.equal(f.routines.get(f.input.id).nativeId, "native-job");
  assert.equal(f.routines.get(f.input.id).state, "ready");
  assert.equal(f.store.list("tasks").length, 0);
  await f.routines.create(f.input);
  assert.equal(f.counts().creates, 2);
  await assert.rejects(async () => f.routines.create({ ...f.input, message: "Conflicting input" }), /conflicts/);
  f.routines.detach(); f.store.close();
});
test("native disable is revision-bound, uncertain repeats are read-only and foreign jobs cannot replace an owned schedule", async () => {
  const f = fixture();
  const created = await f.routines.create(f.input);
  const disabled = await f.routines.setEnabled(created.id, false, created.revision!);
  assert.equal(disabled.enabled, false);
  await f.routines.setEnabled(created.id, false, disabled.revision!);
  assert.equal(f.counts().changes, 1);
  await assert.rejects(f.routines.setEnabled(created.id, true, created.revision!), /Refresh/);
  f.changeNative({ sessionKey: "agent:other:private" });
  await assert.rejects(f.routines.refresh(created.id), /ownership changed/);
  assert.equal(f.routines.get(created.id).enabled, false);
  f.routines.detach(); f.store.close();
});
test("native events update one occurrence receipt, preserve uncertain delivery and do not dispatch model turns", async () => {
  const f = fixture();
  await f.routines.create(f.input);
  await f.routines.refresh(f.input.id);
  await f.routines.refresh(f.input.id);
  const receipts = f.routines.receipts(f.input.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].delivery, "unknown");
  assert.equal(receipts[0].completion, "unknown");
  const changed = new Promise<void>((done) => {
    const observer = (event: { type: string }) => {
      if (event.type !== "routineReceipts.changed") return;
      f.store.off("event", observer); done();
    };
    f.store.on("event", observer);
  });
  f.routines.observe({ type: "frame", generation: 1, frame: { event: "cron", payload: { jobId: "native-job", action: "finished" } } });
  await changed;
  // Join the event-triggered read before detaching the database.
  await f.routines.refresh(f.input.id);
  assert.equal(f.routines.receipts(f.input.id).length, 1);
  assert.deepEqual(f.counts(), { creates: 1, changes: 0 });
  f.routines.detach(); f.store.close();
});

test("a finish event during an older history read gets another pass without a polling timer", async () => {
  const f = fixture();
  await f.routines.create(f.input);
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let reads = 0;
  const original = f.provider.history;
  f.provider.history = async (...args) => {
    reads++;
    if (reads === 1) { await held; return { entries: [], hasMore: false }; }
    return original(...args);
  };
  const reading = f.routines.refresh(f.input.id);
  // Wait until the first history request has actually begun.
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(reads, 1);
  f.routines.observe({ type: "frame", generation: 1, frame: { event: "cron", payload: { jobId: "native-job", action: "finished" } } });
  release();
  await reading;
  assert.equal(reads, 2);
  assert.equal(f.routines.receipts(f.input.id).length, 1);
  f.routines.detach(); f.store.close();
});

test("closing the product prevents a late native history response from touching its closed database", async () => {
  const f = fixture();
  await f.routines.create(f.input);
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const original = f.provider.history;
  f.provider.history = async (...args) => { await held; return original(...args); };
  const reading = f.routines.refresh(f.input.id);
  await new Promise<void>((done) => setImmediate(done));
  f.routines.detach(); f.store.close();
  release();
  await reading;
});

test("an uncertain native disable recovers by reading and never submits a second mutation", async () => {
  const f = fixture();
  const created = await f.routines.create(f.input);
  const original = f.provider.setEnabled;
  f.provider.setEnabled = async (...args) => {
    await original(...args);
    throw new Error("Synthetic disable acknowledgment lost");
  };
  await assert.rejects(f.routines.setEnabled(created.id, false, created.revision!), /acknowledgment lost/);
  assert.equal(f.routines.get(created.id).enabled, true);
  const recovered = await f.routines.setEnabled(created.id, false, created.revision!);
  assert.equal(recovered.enabled, false);
  assert.equal(f.counts().changes, 1);
  f.routines.detach(); f.store.close();
});

test("an access edit reserves its schedule before the native ownership read", async () => {
  const f = fixture();
  const created = await f.routines.create(f.input);
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const original = f.provider.get;
  f.provider.get = async (...args) => { await held; return original(...args); };
  const editing = f.routines.setEnabled(created.id, false, created.revision!);
  await assert.rejects(f.routines.setEnabled(created.id, true, created.revision!), /still being confirmed/);
  release();
  await editing;
  assert.equal(f.counts().changes, 1);
  f.routines.detach(); f.store.close();
});

test("a completed one-time job cannot accidentally replay through the enable control", async () => {
  const f = fixture();
  const created = await f.routines.create(f.input);
  f.changeNative({
    enabled: false, schedule: { kind: "at", at: "2020-01-01T00:00:00.000Z" }, lastRunAt: 1,
  });
  await f.routines.refresh(created.id);
  await assert.rejects(f.routines.setEnabled(created.id, true, created.revision!), /选择新的时间/);
  assert.equal(f.counts().changes, 0);
  f.routines.detach(); f.store.close();
});

test("host cron identity binds one task and cannot borrow a user's concurrent native run", async () => {
  const f = fixture();
  try {
    await f.routines.create(f.input);
    f.changeNative({ runningAt: 10 });
    const input: NativeScheduledRun = {
      trigger: "cron", jobId: "native-job", runId: "scheduled-agent-run",
      sessionId: "native-session", agentId: "atlas", sessionKey: f.native().sessionKey,
    };
    const user = f.store.beginSubmission({
      submissionId: "concurrent-user", botId: f.input.botId,
      conversationId: f.input.conversationId, message: "Independent user turn",
    });
    f.store.acceptSubmission(user.submission.id, "user-native-run", 1);
    f.store.put("runs", { ...f.store.get<Run>("runs", "user-native-run")!, state: "running" });
    const task = (await f.routines.adoptRun(input, 1, () => {}))!;
    assert.notEqual(task.id, user.task.id);
    assert.equal((await f.routines.adoptRun(input, 1, () => {}))?.id, task.id);
    assert.equal(f.store.list<Task>("tasks").length, 2);
    assert.equal(f.store.list("submissions").length, 1);
    assert.equal(f.store.messages(f.input.conversationId).length, 1);
    assert.equal(nativeTask(f.store, input).task.id, task.id);
    await assert.rejects(f.routines.adoptRun({ ...input, runId: "user-native-run" }, 1, () => {}), /already owned/);
    await assert.rejects(f.routines.adoptRun({ ...input, agentId: "other" }, 1, () => {}), /ownership/);
    await assert.rejects(f.routines.adoptRun({ ...input, sessionKey: "other" }, 1, () => {}), /ownership/);
    assert.equal(await f.routines.adoptRun({ ...input, jobId: "kernel-maintenance" }, 1, () => {}), undefined);
    f.store.put("tasks", { ...task, stopRequestedAt: Date.now() });
    assert.throws(() => nativeTask(f.store, input), /authority/);
    await assert.rejects(f.routines.adoptRun(input, 1, () => {}), /no longer active/);
    assert.equal(nativeTask(f.store, { ...input, runId: "user-native-run" }).task.id, user.task.id);
  } finally { f.routines.detach(); f.store.close(); }
});

test("schedule adoption rejects stale kernel responses, changed ownership and inactive native jobs", async () => {
  const f = fixture();
  try {
    await f.routines.create(f.input);
    const input: NativeScheduledRun = {
      trigger: "cron", jobId: "native-job", runId: "scheduled-run",
      sessionId: "native-session", agentId: "atlas", sessionKey: f.native().sessionKey,
    };
    await assert.rejects(f.routines.adoptRun(input, 1, () => {}), /not active/);
    f.changeNative({ runningAt: 10, enabled: false });
    await assert.rejects(f.routines.adoptRun(input, 1, () => {}), /not active/);
    f.changeNative({ enabled: true });
    await assert.rejects(f.routines.adoptRun(input, 1, () => { throw new Error("stale kernel"); }), /stale kernel/);
    f.changeNative({ agentId: "other" });
    await assert.rejects(f.routines.adoptRun(input, 1, () => {}), /ownership/);
    assert.equal(f.store.list("tasks").length, 0);
    assert.equal(f.store.list("runs").length, 0);
  } finally { f.routines.detach(); f.store.close(); }
});

test("pausing scheduled work revokes only its live tasks before the native acknowledgment", async () => {
  const f = fixture();
  try {
    const routine = await f.routines.create(f.input);
    f.changeNative({ runningAt: 10 });
    const input: NativeScheduledRun = {
      trigger: "cron", jobId: "native-job", runId: "scheduled-run",
      sessionId: "session", agentId: "atlas", sessionKey: f.native().sessionKey,
    };
    const task = (await f.routines.adoptRun(input, 1, () => {}))!;
    const user = f.store.beginSubmission({
      submissionId: "live-user", botId: f.input.botId,
      conversationId: f.input.conversationId, message: "Keep working",
    });
    f.store.acceptSubmission(user.submission.id, "user-run", 1);
    f.store.put("runs", { ...f.store.get<Run>("runs", "user-run")!, state: "running" });
    const original = f.provider.setEnabled;
    f.provider.setEnabled = async (...args) => {
      assert.equal(f.store.get<Task>("tasks", task.id)?.status, "stopping");
      assert.throws(() => nativeTask(f.store, input), /authority/);
      assert.equal(nativeTask(f.store, { ...input, runId: "user-run" }).task.id, user.task.id);
      return original(...args);
    };
    await f.routines.setEnabled(f.input.id, false, routine.revision!);
    assert.throws(() => nativeTask(f.store, input), /authority/);
  } finally { f.routines.detach(); f.store.close(); }
});

test("archived Bots can pause schedules but cannot enable or bind another scheduled run", async () => {
  const f = fixture();
  try {
    const created = await f.routines.create(f.input);
    f.store.updateBot(f.input.botId, { archivedAt: Date.now() });
    await f.routines.refresh(created.id);
    const paused = await f.routines.setEnabled(created.id, false, created.revision!);
    assert.equal(paused.enabled, false);
    await assert.rejects(f.routines.setEnabled(created.id, true, paused.revision!), /已归档/);
    await assert.rejects(f.routines.adoptRun({
      trigger: "cron", jobId: "native-job", runId: "archived-run", sessionId: "archived-session",
      agentId: "atlas", sessionKey: f.native().sessionKey,
    }, 1, () => {}), /已归档/);
    assert.equal(f.store.list("tasks").length, 0);
  } finally { f.routines.detach(); f.store.close(); }
});

test("scheduled ownership survives reopening and a new recurrence cannot steal an interrupted task", async () => {
  await mkdir(resolve("local/test-fixtures"), { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/scheduled-ownership-"));
  const path = join(root, "workbench.sqlite");
  const f = fixture(path);
  await f.routines.create(f.input);
  f.changeNative({ runningAt: 10 });
  const input: NativeScheduledRun = {
    trigger: "cron", jobId: "native-job", runId: "first-occurrence",
    sessionId: "native-session", agentId: "atlas", sessionKey: f.native().sessionKey,
  };
  const first = (await f.routines.adoptRun(input, 1, () => {}))!;
  f.store.put("runs", { ...f.store.get<Run>("runs", input.runId)!, state: "interrupted" });
  f.store.updateTask(first.id, "interrupted");
  f.routines.detach(); f.store.close();
  const store = new WorkbenchStore(path);
  const routines = new Routines(store, f.provider);
  try {
    assert.equal(store.ensureRun("second-occurrence", input.sessionKey, 2), undefined);
    const resumed = (await routines.adoptRun(input, 2, () => {}))!;
    assert.equal(resumed.id, first.id);
    assert.equal(store.get<Run>("runs", input.runId)?.state, "running");
    await assert.rejects(routines.adoptRun({ ...input, runId: "conflicting-model-run" }, 2, () => {}), /already belongs/);
    f.changeNative({ runningAt: 20 });
    const second = (await routines.adoptRun({ ...input, runId: "second-occurrence" }, 2, () => {}))!;
    assert.notEqual(second.id, first.id);
    assert.equal(store.list("tasks").length, 2);
    assert.equal(store.list("submissions").length, 0);
  } finally { routines.detach(); store.close(); }
});

test("a stale active-job read cannot undo a pause or grant a new scheduled task", async () => {
  const f = fixture();
  try {
    const created = await f.routines.create(f.input);
    f.changeNative({ runningAt: 10 });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const reading = new Promise<void>((done) => { entered = done; });
    const original = f.provider.get;
    let first = true;
    f.provider.get = async (...args) => {
      if (!first) return original(...args);
      first = false;
      const stale = await original(...args);
      entered(); await held; return stale;
    };
    const adopting = f.routines.adoptRun({
      trigger: "cron", jobId: "native-job", runId: "late-run", sessionId: "session",
      agentId: "atlas", sessionKey: f.native().sessionKey,
    }, 1, () => {});
    await reading;
    await f.routines.setEnabled(created.id, false, created.revision!);
    release();
    await assert.rejects(adopting, /changed during run binding/);
    assert.equal(f.routines.get(created.id).enabled, false);
    assert.equal(f.store.list("tasks").length, 0);
  } finally { f.routines.detach(); f.store.close(); }
});

test("schedule edits retain native identity and receipts; a lost acknowledgment retries without another update", async () => {
  const f = fixture();
  try {
    const routine = await f.routines.create(f.input);
    await f.routines.refresh(routine.id);
    const previousReceipts = f.routines.receipts(routine.id);
    const edit = { name: "Revised summary", message: "Revised task", schedule: { kind: "every" as const, everyMs: 120_000 } };
    const original = f.provider.update;
    let updates = 0;
    f.provider.update = async (...args) => {
      updates++;
      await original(...args);
      throw new Error("Synthetic edit acknowledgment lost");
    };
    await assert.rejects(f.routines.update(routine.id, routine.revision!, edit), /acknowledgment lost/);
    const confirmed = await f.routines.update(routine.id, routine.revision!, edit);
    assert.equal(updates, 1);
    assert.equal(confirmed.nativeId, routine.nativeId);
    assert.equal(confirmed.botId, routine.botId);
    assert.equal(confirmed.enabled, true);
    assert.equal(confirmed.message, edit.message);
    assert.deepEqual(f.routines.receipts(routine.id), previousReceipts);
    assert.equal(f.store.list("tasks").length, 0);
    await assert.rejects(f.routines.update(routine.id, routine.revision!, { ...edit, name: "Conflicting edit" }), /schedule changed/);
    assert.equal(updates, 1);
  } finally { f.routines.detach(); f.store.close(); }
});

test("active or invalid schedule edits leave execution and native policy intact", async () => {
  const f = fixture();
  try {
    const routine = await f.routines.create(f.input);
    let updates = 0;
    const original = f.provider.update;
    f.provider.update = async (...args) => { updates++; return original(...args); };
    const edit = { name: "Changed", message: "Updated brief", schedule: f.input.schedule };
    f.changeNative({ runningAt: 1 });
    await assert.rejects(f.routines.update(routine.id, routine.revision!, edit), /先暂停/);
    f.changeNative({ runningAt: undefined });
    await assert.rejects(f.routines.update(routine.id, routine.revision!, { ...edit, name: " " }), /name and task/);
    await assert.rejects(f.routines.update(routine.id, routine.revision!, {
      ...edit, schedule: { kind: "at", at: "2020-01-01T00:00:00Z" },
    }), /future/);
    assert.equal(updates, 0);
    assert.equal(f.routines.get(routine.id).enabled, true);
  } finally { f.routines.detach(); f.store.close(); }
});

test("an older native refresh cannot overwrite a confirmed schedule edit", async () => {
  const f = fixture();
  try {
    const routine = await f.routines.create(f.input);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const reading = new Promise<void>((done) => { entered = done; });
    const original = f.provider.get;
    let first = true;
    f.provider.get = async (...args) => {
      if (!first) return original(...args);
      first = false;
      const stale = await original(...args);
      entered(); await held; return stale;
    };
    const refreshing = f.routines.refresh(routine.id);
    await reading;
    const edit = { name: "Confirmed edit", message: "Updated task", schedule: f.input.schedule };
    await f.routines.update(routine.id, routine.revision!, edit);
    release(); await refreshing;
    assert.equal(f.routines.get(routine.id).name, edit.name);
    assert.equal(f.routines.get(routine.id).revision, "edited-revision");
  } finally { f.routines.detach(); f.store.close(); }
});
