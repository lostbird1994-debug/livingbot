import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, lstat, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { BotRemoval } from "./bot-removal.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import type { WorkbenchService } from "../../../packages/workbench/src/service.ts";

async function fixture() {
  await mkdir("local/test-fixtures",{recursive:true});const root=await mkdtemp(resolve("local/test-fixtures/bot-delete-parity-"));
  const store=new WorkbenchStore(":memory:");const bot=store.createBot({name:"Selected"});const other=store.createBot({name:"Child retained"});
  const workspaces=new Workspaces(join(root,"workspaces"));const workspace=await workspaces.initialize(bot.agentId);await workspaces.initialize(other.agentId);
  await mkdir(join(root,"kernel-state/agents",bot.agentId),{recursive:true});await writeFile(join(workspace,"memory/example.md"),"Retained preference");
  const chat=store.privateConversation(bot.id);store.put("messages",{id:"private",conversationId:chat.id,botId:bot.id,blocks:[{kind:"text",text:"private"}]});
  store.put("routines",{id:"routine",botId:bot.id,enabled:true});store.put("conversations",{id:"group",kind:"group",botIds:[bot.id,other.id],createdAt:1});
  const config:any={agents:{entries:{[bot.agentId]:{workspace},[other.agentId]:{workspace:join(workspaces.root,other.agentId)}}},memory:{search:{provider:"synthetic",extraPaths:["/synthetic/existing"]}}};
  const calls:{method:string;input:any}[]=[];let fail=false;
  const kernel={async request<T>(method:string,input:any):Promise<T>{calls.push({method,input});if(method==="config.get")return{hash:"revision",config} as T;if(method==="agents.delete"){if(fail)throw new Error("Native failure");assert.equal(input.deleteFiles,false);delete config.agents.entries[input.agentId];return{ok:true} as T;}if(method==="config.patch"){Object.assign(config.memory.search,JSON.parse(input.raw).memory.search);return{} as T;}throw Error(method);}};
  const removal=new BotRemoval({store,kernel,async cancel(){}} as unknown as WorkbenchService,workspaces);
  return{root,store,bot,other,workspace,config,calls,removal,setFail(value:boolean){fail=value;},async close(){store.close();const recovery=join(homedir(),".Trash",`LivingBot-bot-parity-test-${randomUUID()}`);await rename(root,recovery);console.log({original:root,recovery});}};
}
for(const deleteMemories of[false,true])test(`1.0 deletion flow with deleteMemories=${deleteMemories}`,async()=>{const f=await fixture();try{
  assert.deepEqual(await f.removal.remove(f.bot.id,deleteMemories),{ok:true});assert.equal(f.store.get("bots",f.bot.id),undefined);assert.ok(f.store.get("bots",f.other.id));
  assert.equal(f.store.get("messages","private"),undefined);assert.equal(f.store.get("routines","routine"),undefined);assert.deepEqual(f.store.get<any>("conversations","group").botIds,[f.other.id]);
  await assert.rejects(lstat(f.workspace),{code:"ENOENT"});const shared=join(f.root,"shared-memory/deleted-bots",f.bot.id,"memory/example.md");
  const receipt=f.store.get<any>("settings",`bot-deletion:${f.bot.id}`);
  assert.equal(receipt.recoveryPaths.length,2);
  assert.equal(await readFile(join(receipt.recoveryPaths[0].recovery,"memory/example.md"),"utf8"),"Retained preference");
  if(deleteMemories){await assert.rejects(lstat(shared),{code:"ENOENT"});assert.deepEqual(f.config.memory.search.extraPaths,["/synthetic/existing"]);}else{assert.equal(await readFile(shared,"utf8"),"Retained preference");assert.ok(f.config.memory.search.extraPaths.includes(join(f.root,"shared-memory")));assert.equal(f.config.memory.search.provider,"synthetic");}
  const count=f.calls.length;assert.deepEqual(await f.removal.remove(f.bot.id,deleteMemories),{ok:true});assert.equal(f.calls.length,count);
}finally{await f.close();}});
test("native deletion failure preserves files and product history for retry",async()=>{const f=await fixture();try{f.setFail(true);await assert.rejects(f.removal.remove(f.bot.id,true),/Native failure/);assert.equal(await readFile(join(f.workspace,"memory/example.md"),"utf8"),"Retained preference");assert.ok(f.store.get("messages","private"));f.setFail(false);await f.removal.remove(f.bot.id,true);assert.equal(f.store.get("bots",f.bot.id),undefined);}finally{await f.close();}});
test("shared native directories are rejected before irreversible work",async()=>{const f=await fixture();try{f.config.agents.entries[f.other.agentId].workspace=join(f.workspace,"shared");await assert.rejects(f.removal.remove(f.bot.id,true),/其他 Bot/);assert.ok(!f.calls.some(x=>x.method==="agents.delete"));assert.ok(f.store.get("bots",f.bot.id));}finally{await f.close();}});
test("inherited authorization ownership is rejected before retiring the native Bot",async()=>{const f=await fixture();try{f.config.agents.defaults={authInheritance:{agentId:f.bot.agentId}};await assert.rejects(f.removal.remove(f.bot.id,true),/授权继承来源/);assert.ok(!f.calls.some(x=>x.method==="agents.delete"));assert.ok(f.store.get("messages","private"));}finally{await f.close();}});
test("a Trash conflict preserves original files and retry resumes the reserved recovery paths",async()=>{const f=await fixture();try{
  f.setFail(true);await assert.rejects(f.removal.remove(f.bot.id,true),/Native failure/);
  const receipt=f.store.get<any>("settings",`bot-deletion:${f.bot.id}`);const target=receipt.recoveryPaths[0].recovery;
  await mkdir(target);f.setFail(false);await assert.rejects(f.removal.remove(f.bot.id,true),/废纸篓目标已存在/);
  assert.ok(f.store.get("bots",f.bot.id));assert.equal(await readFile(join(f.workspace,"memory/example.md"),"utf8"),"Retained preference");
  await rename(target,target+"-conflict-fixture");await f.removal.remove(f.bot.id,true);
  assert.equal(f.store.get("bots",f.bot.id),undefined);assert.equal(await readFile(join(target,"memory/example.md"),"utf8"),"Retained preference");
}finally{await f.close();}});
