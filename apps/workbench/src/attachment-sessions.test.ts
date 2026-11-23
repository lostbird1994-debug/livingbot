import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { Submission } from "../../../packages/kernel-runtime/src/contracts.ts";
import { Files } from "../../../packages/workbench/src/files.ts";
import { WorkbenchService } from "../../../packages/workbench/src/service.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import { createWorkbenchApi } from "./http.ts";

class Kernel extends EventEmitter {
  generation=1;phase="ready";sent:Submission[]=[];
  async request<T>(){return [] as T;}
  async recoverHistory(){return {messages:[]};}
  async send(input:Submission){this.sent.push(input);return {runId:input.idempotencyKey,status:"started"};}
  async abort(){return {aborted:true};}
}
test("draft attachments survive first-send retry and remain isolated from main and other task sessions",async()=>{
 await mkdir("local/test-fixtures",{recursive:true});
 const root=await mkdtemp(resolve("local/test-fixtures/attachment-sessions-"));
 const store=new WorkbenchStore(":memory:");const bot=store.createBot({name:"Synthetic",agentId:"synthetic"});
 const main=store.privateConversation(bot.id);const kernel=new Kernel();const workspaces=new Workspaces(root);
 const files=new Files(store,workspaces);const service=new WorkbenchService(store,kernel,undefined,files);
 const api=createWorkbenchApi({service,token:"synthetic-test-token-with-at-least-32-characters"});const origin=await api.listen();
 const headers={authorization:"Bearer synthetic-test-token-with-at-least-32-characters","content-type":"application/json"};
 const post=async(path:string,input:unknown)=>fetch(origin+path,{method:"POST",headers,body:JSON.stringify(input)});
 try{
  const body={kind:"private",botIds:[bot.id],title:"Independent draft",clientNonce:"draft:synthetic"};
  const first=await post("/api/conversations",body);assert.equal(first.status,201);const chat=await first.json() as {id:string};
  const id=randomUUID();const path=`/api/conversations/${chat.id}/attachments/${id}?`+new URLSearchParams({botId:bot.id,name:"image.png",mediaType:"image/png"});
  const bytes=Uint8Array.from([137,80,78,71]);
  const upload=()=>fetch(origin+path,{method:"POST",headers:{authorization:headers.authorization,"content-type":"application/octet-stream"},body:bytes});
  const saved=await upload();assert.equal(saved.status,201);assert.equal((await saved.json()).conversationId,chat.id);
  assert.equal((await upload()).status,201);
  const retry=await post("/api/conversations",body);assert.equal((await retry.json()).id,chat.id);
  const accepted=await post("/api/submissions",{submissionId:"draft:synthetic",botId:bot.id,conversationId:chat.id,message:"Read attachment",attachmentIds:[id]});
  assert.equal(accepted.status,202);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(kernel.sent.length,1);assert.ok(kernel.sent[0]!.attachments?.some(file=>file.content===Buffer.from(bytes).toString("base64")));
  assert.equal(store.messages(main.id).length,0);
  assert.throws(()=>files.validateAttachments([id],bot.id,main.id),/belong/);
  assert.equal(store.list("artifacts",-1).length,1);
 }finally{
  await api.close();service.detach();store.close();
  const recovery=join(homedir(),".Trash",`LivingBot-attachment-test-${randomUUID()}`);await rename(root,recovery);console.log({original:root,recovery});
 }
});
