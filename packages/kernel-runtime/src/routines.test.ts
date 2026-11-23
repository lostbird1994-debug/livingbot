import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRequests } from "./contracts.ts";
import { OpenClawRoutines, routineSchedule } from "./routines.ts";

const definition = {
  declarationKey: "livingbot:synthetic", agentId: "atlas", sessionKey: "agent:atlas:explicit:synthetic",
  name: "Weekly summary", message: "Summarize synthetic project work",
  schedule: { kind: "every" as const, everyMs: 86_400_000 },
};
function fixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let saved: Record<string, unknown> | undefined;
  let lost = false;
  const gateway: GatewayRequests = {
    async request<T>(method: string, params: unknown): Promise<T> {
      const input = params as Record<string, unknown>;
      calls.push({ method, params: input });
      if (method === "cron.list") return { jobs: saved ? [saved] : [], hasMore: false } as T;
      if (method === "cron.add") {
        saved = { ...input, id: "native-job", configRevision: "revision-one", state: { nextRunAtMs: 123 } };
        if (lost) { lost = false; throw new Error("Synthetic lost creation acknowledgment"); }
        return { created: true, job: saved } as T;
      }
      if (method === "cron.get") return saved as T;
      if (method === "cron.update") {
        saved = { ...saved, ...(input.patch as object), configRevision: "revision-two" };
        return saved as T;
      }
      if (method === "cron.runs") return { entries: [{
        jobId: "native-job", runId: "occurrence", ts: 234, status: "ok",
        completionStatus: "unknown", deliveryStatus: "not-delivered", summary: "Synthetic outcome",
        diagnostics: { secret: "not exposed" }, delivery: { to: "not exposed" },
      }], hasMore: false } as T;
      return {} as T;
    },
  };
  return {
    adapter: new OpenClawRoutines(gateway), calls,
    loseCreation() { lost = true; }, changeSaved(value: Record<string, unknown>) { saved = { ...saved, ...value }; },
  };
}
test("native schedule creation retains jobs, uses internal delivery and recovers a lost acknowledgment without overwriting", async () => {
  const f = fixture();
  f.loseCreation();
  await assert.rejects(f.adapter.create(definition), /lost creation/);
  const recovered = await f.adapter.create(definition);
  assert.equal(recovered.id, "native-job");
  assert.equal(f.calls.filter((call) => call.method === "cron.add").length, 1);
  const sent = f.calls.find((call) => call.method === "cron.add")!.params;
  assert.equal("message" in sent, false);
  assert.deepEqual(sent.payload, { kind: "agentTurn", message: definition.message });
  assert.deepEqual(sent.delivery, { mode: "none" });
  assert.equal(sent.deleteAfterRun, false);
  assert.equal(sent.sessionTarget, `session:${definition.sessionKey}`);
  f.changeSaved({ payload: { kind: "agentTurn", message: "Changed by owner" } });
  await assert.rejects(f.adapter.create(definition), /differs/);
  assert.equal(f.calls.filter((call) => call.method === "cron.add").length, 1);
});
test("native enable changes use definition revision and run summaries retain uncertain delivery without private traces", async () => {
  const f = fixture();
  await f.adapter.create(definition);
  const disabled = await f.adapter.setEnabled("native-job", "revision-one", false);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(f.calls.find((call) => call.method === "cron.update")!.params, {
    id: "native-job", expectedConfigRevision: "revision-one", patch: { enabled: false },
  });
  const page = await f.adapter.history("native-job");
  assert.equal(page.entries[0].completion, "unknown");
  assert.equal(page.entries[0].delivery, "not-delivered");
  assert.equal(JSON.stringify(page).includes("not exposed"), false);
});
test("editing patches only schedule content under its observed native revision", async () => {
  const f = fixture();
  await f.adapter.create(definition);
  const edit = { name: "Revised work", message: "Revised brief", schedule: { kind: "cron" as const, expr: "15 9 * * 1-5", tz: "Asia/Shanghai" } };
  const saved = await f.adapter.update("native-job", "revision-one", edit);
  assert.deepEqual(f.calls.find((call) => call.method === "cron.update")!.params, {
    id: "native-job", expectedConfigRevision: "revision-one", patch: {
      name: edit.name, schedule: edit.schedule, payload: { kind: "agentTurn", message: edit.message },
    },
  });
  assert.equal(saved.id, "native-job");
  assert.equal(saved.enabled, true);
  assert.equal(saved.sessionKey, definition.sessionKey);
});
test("invalid interval, timezone, date and agent fail before native mutation", async () => {
  for (const schedule of [
    { kind: "every", everyMs: 0 }, { kind: "every", everyMs: 1000 }, { kind: "cron", expr: "* * * * *", tz: "Invalid/Zone" },
    { kind: "at", at: "tomorrow" }, { kind: "command", command: "synthetic" },
  ]) assert.throws(() => routineSchedule(schedule));
  const f = fixture();
  await assert.rejects(f.adapter.create({ ...definition, agentId: "../foreign" }));
  assert.equal(f.calls.length, 0);
});

test("native timestamp-only outcomes remain inspectable without inventing a native run id or success", async () => {
  const gateway: GatewayRequests = {
    async request<T>(): Promise<T> {
      return { entries: [
        { jobId: "native-job", ts: 123, runAtMs: 120, status: "skipped" },
        { jobId: "native-job", ts: 234 },
      ], hasMore: false } as T;
    },
  };
  const page = await new OpenClawRoutines(gateway).history("native-job");
  assert.deepEqual(page.entries.map((entry) => [entry.occurrenceKey, entry.runId, entry.status, entry.delivery]), [
    ["time:120", undefined, "skipped", "unknown"], ["time:234", undefined, "unknown", "unknown"],
  ]);
});

test("an old detached schedule cannot be accepted as an execution bound to the destination session", async () => {
  const f = fixture();
  await f.adapter.create(definition);
  f.changeSaved({ sessionTarget: "isolated" });
  await assert.rejects(f.adapter.get("native-job"), /execution session differs/);
  await assert.rejects(f.adapter.create(definition), /execution session differs/);
  assert.equal(f.calls.filter((call) => call.method === "cron.add").length, 1);
});

test("a native schedule redirected to an external channel cannot be silently adopted or edited", async () => {
  const f = fixture();
  await f.adapter.create(definition);
  f.changeSaved({ delivery: { mode: "announce", channel: "synthetic", to: "foreign" } });
  await assert.rejects(f.adapter.get("native-job"), /conversation-only/);
  await assert.rejects(f.adapter.create(definition), /conversation-only/);
  assert.equal(f.calls.filter((call) => call.method === "cron.add").length, 1);
});
