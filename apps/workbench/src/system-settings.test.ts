import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  NativeRoutine,
  RoutineDefinition,
  RoutineEdit,
  RoutineProvider,
} from "../../../packages/kernel-runtime/src/routines.ts";
import type { KernelControl } from "../../../packages/workbench/src/service.ts";
import { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import {
  CAPABILITY_AUDIT_INSTRUCTIONS,
  SUPER_ADMIN_AGENT_ID,
} from "../../../packages/workbench/src/system-policy.ts";
import { SystemSettings } from "./system-settings.ts";

class Schedules implements RoutineProvider {
  rows = new Map<string, NativeRoutine>();
  created = 0;
  removed = 0;
  async create(input: RoutineDefinition) {
    const existing = [...this.rows.values()].find(
      (row) => row.declarationKey === input.declarationKey,
    );
    if (existing) return existing;
    const row = {
      ...input,
      id: `job-${++this.created}`,
      enabled: true,
      revision: String(this.created),
      nextRunAt: Date.now() + 100000,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async get(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing schedule");
    return row;
  }
  async update(id: string, revision: string, change: RoutineEdit) {
    const row = await this.get(id);
    assert.equal(row.revision, revision);
    Object.assign(row, change, { revision: `${revision}-next` });
    return row;
  }
  async setEnabled(id: string, revision: string, enabled: boolean) {
    const row = await this.get(id);
    assert.equal(row.revision, revision);
    row.enabled = enabled;
    return row;
  }
  async remove(id: string, revision: string) {
    assert.equal((await this.get(id)).revision, revision);
    this.rows.delete(id);
    this.removed++;
  }
  async history() {
    return { entries: [], hasMore: false };
  }
  async runNow() {
    return { runId: null };
  }
}
test("fixed audit instructions create one native schedule, update it and remove it when disabled", async () => {
  const store = new WorkbenchStore(":memory:");
  const kernel = Object.assign(new EventEmitter(), {
    phase: "ready",
    generation: 1,
    request: async () => [],
    send: async () => ({ runId: "unused", status: "started" }),
    recoverHistory: async () => ({ messages: [] }),
    abort: async () => ({ aborted: true }),
  }) as unknown as KernelControl;
  const schedules = new Schedules();
  const service = new WorkbenchService(store, kernel, undefined, undefined, undefined, schedules);
  store.createBot({ name: "Administrator", agentId: SUPER_ADMIN_AGENT_ID });
  const settings = new SystemSettings(service);
  const input = {
    enabled: true,
    cadence: "weekly" as const,
    hour: 9,
    minute: 0,
    weekday: 1,
    timezone: "UTC",
  };
  try {
    assert.equal(settings.read().enabled, false);
    const unavailable = new SystemSettings(service, undefined, undefined, async () => false);
    await assert.rejects(unavailable.save(input), /先配置模型/);
    assert.equal(settings.read().enabled, false);
    assert.equal(schedules.rows.size, 0);
    const first = await settings.save(input);
    assert.equal(first.routine?.state, "ready");
    assert.equal(schedules.created, 1);
    const admin = store.list<any>("bots")[0];
    assert.notEqual(
      [...schedules.rows.values()][0]?.sessionKey,
      store.engineSessionKey(store.privateConversation(admin.id).id, admin.id),
    );
    assert.equal([...schedules.rows.values()][0]?.message, CAPABILITY_AUDIT_INSTRUCTIONS);
    await settings.save(input);
    assert.equal(schedules.created, 1);
    await settings.save({ ...input, hour: 10 });
    assert.equal(schedules.created, 1);
    assert.equal([...schedules.rows.values()][0]?.schedule.kind, "cron");
    await assert.rejects(
      settings.save({ ...input, instructions: "replace policy" } as any),
      /检查/,
    );
    await settings.save({ ...input, enabled: false });
    assert.equal(schedules.removed, 1);
    assert.equal(schedules.rows.size, 0);
    assert.equal(settings.read().enabled, false);
    assert.equal(settings.read().routineId, undefined);
    await settings.save(input);
    assert.equal(schedules.created, 2);
    assert.equal(schedules.rows.size, 1);
    const target = store.createBot({ name: "Writer", agentId: "writer" });
    const own = await settings.save(input, target.id);
    assert.equal(own.routine?.state, "ready");
    const routine = store.get<any>("routines", own.routineId!);
    assert.equal(routine.botId, target.id);
    assert.equal(routine.name, "专属能力审计");
    assert.notEqual(routine.message, CAPABILITY_AUDIT_INSTRUCTIONS);
    assert.equal(settings.read(target.id).enabled, true);
    await settings.save({ ...input, enabled: false }, target.id);
    assert.equal(settings.read(target.id).enabled, false);
    assert.equal(settings.read().enabled, true);
  } finally {
    service.detach();
    store.close();
  }
});

test("configuration guidance carries the authoritative target and reuses only that ability's active task",async t=>{
 const store=new WorkbenchStore(":memory:");const kernel=Object.assign(new EventEmitter(),{phase:"ready",generation:1,request:async()=>[],send:async()=>({runId:"unused",status:"started"}),recoverHistory:async()=>({messages:[]}),abort:async()=>({aborted:true})}) as unknown as KernelControl;
 const service=new WorkbenchService(store,kernel);store.createBot({name:"Administrator",agentId:SUPER_ADMIN_AGENT_ID});
 Object.defineProperty(service,"abilities",{value:{listShared:async()=>[{id:"mail",name:"Mail",kind:"service",source:"mcp",configuration:{native:{nativeKind:"service",nativeName:"mail"},sharedAccess:{enabled:true,ready:false,reason:"Authorization required"}}}]}});
 const messages:string[]=[];t.mock.method(service,"submit",async(input:any)=>{messages.push(input.message);return store.put("tasks",{id:`guide-${messages.length}`,botId:input.botId,status:"running"}) as any;});const settings=new SystemSettings(service);
 try{const first=await settings.startConfiguration("mail");const second=await settings.startConfiguration("mail");assert.equal(first.taskId,second.taskId);assert.equal(messages.length,1);assert.ok(messages[0]?.includes('"id":"mail"'));assert.ok(messages[0]?.includes('capability-setup=mail'));await assert.rejects(settings.startConfiguration("unknown"));assert.equal(messages.length,1);
 }finally{service.detach();store.close();}
});
