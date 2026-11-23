import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { freeLoopbackPort, launchWorkbench } from "./main.ts";
import type { Artifact, Interaction, Task } from "../../../packages/workbench/src/contracts.ts";
import type { RuntimeObservation } from "../../../packages/kernel-runtime/src/contracts.ts";
import { preparePaths, runtimePaths } from "../../../packages/kernel-runtime/src/paths.ts";
import { WorkbenchStore } from "../../../packages/workbench/src/store.ts";
import { buildKernelConfig, newGatewayToken, writeKernelConfig } from "../../../packages/kernel-runtime/src/config.ts";

// Explicit integration entry: no external provider, no production workspace,
// no package lifecycle, no background cleanup or permanent deletion.
const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
const fixtures = resolve("local/test-fixtures");
await mkdir(fixtures, { recursive: true });
const root = await mkdtemp(join(fixtures, "new-service-kernel-"));
const requests: unknown[] = [];
let holdSeen!: () => void;
const held = new Promise<void>((resolve) => { holdSeen = resolve; });
let hasHeld = false;
let questionDispatched = false;
const approvalsDispatched = new Set<string>();
const contextsDispatched = new Set<string>();
let contextSourceId = "";
let fileStep = 0;
let assignmentDispatched = false;
let assignmentTargetId = "";
let cancelAssignmentDispatched = false;
let childHoldSeen!: () => void;
const childHeld = new Promise<void>((resolve) => { childHoldSeen = resolve; });
let hasHeldChild = false;
let unrelatedSeen!: () => void;
const unrelatedHeld = new Promise<void>((resolve) => { unrelatedSeen = resolve; });
let unrelatedRelease!: () => void;
const unrelatedReleased = new Promise<void>((resolve) => { unrelatedRelease = resolve; });
let hasHeldUnrelated = false;
let attachedPath = "";
const attachmentText = "Synthetic attached source: deliver exactly this content.";
const model = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: { role: string; content: unknown }[];
      tools?: { function?: { name?: string } }[];
    };
    requests.push({
      path: request.url, roles: body.messages.map((message) => message.role),
      tools: body.tools?.map((tool) => tool.function?.name),
      toolResults: body.messages.filter((message) => message.role === "tool"),
      fileHistory: body.messages.filter((message) => message.role === "user" &&
        JSON.stringify(message.content).includes("WORKBENCH_FILES")),
      groupHistory: body.messages.filter((message) => message.role === "user" &&
        JSON.stringify(message.content).includes("WORKBENCH_GROUP_PRIVATE_REPORT")),
      questionHistory: body.messages.some((message) =>
        message.role === "user" && JSON.stringify(message.content).includes("WORKBENCH_QUESTION"))
        ? body.messages.filter((message) => message.role === "assistant") : undefined,
    });
    if (body.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("WORKBENCH_PROVIDER_FAILURE"))) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic provider rejection", type: "invalid_request_error" } }));
      return;
    }
    if (!hasHeldChild && body.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("WORKBENCH_CHILD_CANCEL_HOLD"))) {
      hasHeldChild = true; childHoldSeen();
      await new Promise<void>((resolve) => response.once("close", resolve));
      return;
    }
    if (!hasHeldUnrelated && body.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("WORKBENCH_UNRELATED_LIVE"))) {
      hasHeldUnrelated = true; unrelatedSeen();
      await unrelatedReleased;
    }
    if (!hasHeld && body.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("WORKBENCH_HOLD"))) {
      hasHeld = true; holdSeen();
      await new Promise<void>((resolve) => response.once("close", resolve));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    emit({ role: "assistant" });
    const questionTurn = !questionDispatched && body.messages.some((message) =>
      message.role === "user" && JSON.stringify(message.content).includes("WORKBENCH_QUESTION"));
    const approvalTurn = ["allow", "deny"].find((decision) => !approvalsDispatched.has(decision) &&
      body.messages.some((message) => message.role === "user" &&
        JSON.stringify(message.content).includes(`WORKBENCH_APPROVAL_${decision.toUpperCase()}`)));
    const contextTurn = ["ALLOW", "OTHER_PRIVATE", "GROUP_PRIVATE", "SHARED", "REVOKED"].find((kind) =>
      !contextsDispatched.has(kind) && body.messages.some((message) =>
        message.role === "user" && JSON.stringify(message.content).includes(`WORKBENCH_CONTEXT_${kind}`)));
    const fileTurn = fileStep < 3 && body.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("WORKBENCH_FILES"));
    const privateReportTurn = body.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("WORKBENCH_GROUP_PRIVATE_REPORT")) &&
      !body.messages.some((message) => message.role === "tool" &&
        JSON.stringify(message.content).includes("taskId") && JSON.stringify(message.content).includes("conversationId"));
    const assignmentTurn = !assignmentDispatched && body.messages.some((message) =>
      message.role === "user" && JSON.stringify(message.content).includes("WORKBENCH_COORDINATE"));
    const cancelAssignmentTurn = !cancelAssignmentDispatched && body.messages.some((message) =>
      message.role === "user" && JSON.stringify(message.content).includes("WORKBENCH_COORDINATE_CANCEL"));
    if (questionTurn) questionDispatched = true;
    if (questionTurn) emit({ tool_calls: [{ index: 0, id: "synthetic-question-call", type: "function", function: {
      name: "dispatch_action", arguments: JSON.stringify({ id: "ask_user", args: { questions: [{
        id: "delivery_target", header: "交付位置", question: "选择交付位置",
        options: [{ label: "本机文件" }, { label: "对话预览" }],
      }] } }),
    } }] });
    else if (assignmentTurn || cancelAssignmentTurn) {
      assignmentDispatched = true;
      if (cancelAssignmentTurn) cancelAssignmentDispatched = true;
      emit({ tool_calls: [{ index: 0, id: cancelAssignmentTurn ? "synthetic-cancel-assignment" : "synthetic-group-assignment", type: "function", function: {
        name: "dispatch_action", arguments: JSON.stringify({
          id: "livingbot_assign_group", args: { assignments: [{
            botId: assignmentTargetId, message: cancelAssignmentTurn
              ? "WORKBENCH_CHILD_CANCEL_HOLD Prepare the delegated long-running evidence brief."
              : "Prepare the delegated synthetic evidence brief.", report: "private",
          }] },
        }),
      } }] });
    } else if (privateReportTurn) {
      emit({ tool_calls: [{ index: 0, id: "synthetic-private-report", type: "function", function: {
        name: "dispatch_action", arguments: JSON.stringify({ id: "livingbot_report_privately", args: {} }),
      } }] });
    } else if (contextTurn) {
      contextsDispatched.add(contextTurn);
      emit({ tool_calls: [{ index: 0, id: "synthetic-context-call", type: "function", function: {
        name: "dispatch_action", arguments: JSON.stringify({
          id: "livingbot_conversations", args: { operation: "read", conversationId: contextSourceId },
        }),
      } }] });
    } else if (fileTurn) {
      const calls = [
        { name: "read", args: { path: attachedPath } },
        { name: "write", args: { path: "tasks/contract-output.md", content: attachmentText } },
        { name: "dispatch_action", args: { id: "livingbot_deliver_file", args: {
          relativePath: "tasks/contract-output.md", mediaType: "text/markdown",
        } } },
      ];
      const call = calls[fileStep++];
      emit({ tool_calls: [{ index: 0, id: `synthetic-file-${fileStep}`, type: "function", function: {
        name: call.name, arguments: JSON.stringify(call.args),
      } }] });
    } else if (approvalTurn) {
      approvalsDispatched.add(approvalTurn);
      emit({ tool_calls: [{ index: 0, id: `synthetic-approval-${approvalTurn}`, type: "function", function: {
        name: "exec", arguments: JSON.stringify({
          command: `/usr/bin/touch approval-marker-${approvalTurn}`, host: "gateway", ask: "always",
        }),
      } }] });
    } else emit({ content: "Synthetic workbench result." });
    emit({}, questionTurn || approvalTurn || contextTurn || fileTurn || privateReportTurn || assignmentTurn || cancelAssignmentTurn ? "tool_calls" : "stop"); response.end("data: [DONE]\n\n");
  } catch {
    response.writeHead(500); response.end();
  }
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
const nativeEvents = new Set<string>();
const evidence: { scenarios: string[]; root: string; requests: unknown[]; nativeEvents: string[]; error?: string } = {
  scenarios: [], root, requests, nativeEvents: [],
};

function untilTerminal(taskId: string): Promise<Task> {
  const store = app!.store;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Product task terminal deadline exceeded")); }, 45_000);
    const changed = () => {
      const task = store.get<Task>("tasks", taskId);
      if (task && ["completed", "failed", "cancelled"].includes(task.status)) {
        clearTimeout(timer); store.off("event", changed); resolve(task);
      }
    };
    store.on("event", changed); changed();
  });
}

function untilQuestion(taskId: string, kind: Interaction["kind"] = "question"): Promise<Interaction> {
  const store = app!.store;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Question arrival deadline exceeded")); }, 30_000);
    const changed = () => {
      const prompt = store.list<Interaction>("interactions").find((item) =>
        item.taskId === taskId && item.kind === kind && item.status === "pending");
      if (prompt) { clearTimeout(timer); store.off("event", changed); resolve(prompt); }
    };
    store.on("event", changed); changed();
  });
}

try {
  const appRoot = join(root, "application");
  const paths = runtimePaths(appRoot);
  await preparePaths(paths);
  for (const agentId of ["first", "second"]) {
    const skillRoot = join(paths.workspaces, agentId, "skills", "synthetic-method");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: synthetic-method\ndescription: Synthetic method for capability acceptance.\n---\nReturn a synthetic result when asked.\n", {
      mode: 0o600, flag: "wx",
    });
  }
  const initial = new WorkbenchStore(join(appRoot, "workbench.sqlite"));
  initial.createBot({ name: "First", agentId: "first" });
  initial.createBot({ name: "Second", agentId: "second" });
  initial.close();
  const connection = {
      id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions" as const, apiKey: "synthetic-not-a-secret", model: "synthetic",
      contextWindow: 32_000, maxTokens: 1000,
  };
  const config = buildKernelConfig(paths, await freeLoopbackPort(), newGatewayToken(), [
    { id: "first" }, { id: "second" },
  ], connection);
  config.tools = { exec: { mode: "ask" } };
  await writeKernelConfig(paths, config);
  app = await launchWorkbench({
    root: appRoot, kernelEntry: resolve(values["kernel-entry"]),
    nodeExecutable: process.execPath,
  });
  app.kernel.on("observation", (observation: RuntimeObservation) => {
    if (observation.type !== "frame") return;
    const { event, payload } = observation.frame;
    if (event === "agent") nativeEvents.add(`agent:${String(payload?.stream)}`);
    if (event === "chat") nativeEvents.add(`chat:${String(payload?.state)}`);
  });
  evidence.scenarios.push("independent-gateway-handshake");
  const bot = app.store.snapshot().bots[0];
  const conversation = app.store.privateConversation(bot.id);
  const initialAbilities = await app.service.abilities!.refresh(bot.id);
  assert.ok(initialAbilities.some((ability) => ability.name === "synthetic-method"));
  assert.equal(requests.length, 0);
  evidence.scenarios.push("native-ability-inventory-before-first-message");
  const input = {
    submissionId: randomUUID(), conversationId: conversation.id, botId: bot.id, message: "Synthetic contract run",
  };
  const task = await app.service.submit(input);
  assert.equal((await untilTerminal(task.id)).status, "completed");
  const messages = app.store.messages(conversation.id);
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal(messages.filter((message) => message.role === "assistant" && message.final).length, 1);
  assert.ok(messages.some((message) => message.blocks.some((block) =>
    block.kind === "text" && block.text === "Synthetic workbench result.")));
  evidence.scenarios.push("new-service-native-execution-and-durable-final");
  const abilities = await app.service.abilities!.refresh(bot.id);
  const reading = abilities.find((ability) =>
    (ability.configuration?.native as { nativeName?: string })?.nativeName === "read")!;
  assert.ok(reading);
  assert.equal(reading.access?.[bot.id].enabled, true);
  const disabled = await app.service.abilities!.setEnabled(reading.id, bot.id, false);
  assert.equal(disabled.find((ability) => ability.id === reading.id)?.access?.[bot.id].enabled, false);
  const policyConversation = app.store.createConversation("private", [bot.id], "Synthetic policy verification");
  const policyInput = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: policyConversation.id,
    message: "Synthetic turn after disabling file reading",
  });
  assert.equal((await untilTerminal(policyInput.id)).status, "completed");
  assert.ok(!(requests.at(-1) as { tools: string[] }).tools.includes("read"));
  const restored = await app.service.abilities!.setEnabled(reading.id, bot.id, true);
  assert.equal(restored.find((ability) => ability.id === reading.id)?.access?.[bot.id].enabled, true);
  const restoredInput = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: policyConversation.id,
    message: "Synthetic turn after restoring file reading",
  });
  assert.equal((await untilTerminal(restoredInput.id)).status, "completed");
  assert.ok((requests.at(-1) as { tools: string[] }).tools.includes("read"));
  const method = restored.find((ability) => ability.name === "synthetic-method")!;
  const hidden = await app.service.abilities!.setEnabled(method.id, bot.id, false);
  assert.equal(hidden.find((ability) => ability.id === method.id)?.access?.[bot.id].enabled, false);
  const otherBot = app.store.snapshot().bots.find((candidate) => candidate.id !== bot.id)!;
  const otherAbilities = await app.service.abilities!.refresh(otherBot.id);
  assert.equal(otherAbilities.find((ability) => ability.name === "synthetic-method")?.access?.[otherBot.id].enabled, true);
  await app.service.abilities!.setEnabled(method.id, bot.id, true);
  evidence.scenarios.push("native-tool-and-skill-access-toggle-is-scoped-to-one-bot");
  const before = requests.length;
  assert.equal((await app.service.submit(input)).id, task.id);
  assert.equal(requests.length, before);
  evidence.scenarios.push("product-retry-does-not-dispatch");
  await app.kernel.restart();
  await app.service.reconcile();
  assert.equal(app.store.messages(conversation.id).filter((message) => message.role === "user").length, 1);
  assert.equal(app.service.task(task.id).status, "completed");
  evidence.scenarios.push("gateway-restart-reconcile-preserves-task-and-input");
  const token = (JSON.parse(await readFile(app.authPath, "utf8")) as { token: string }).token;
  const snapshot = await fetch(`${app.url}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(snapshot.status, 200);
  evidence.scenarios.push("authenticated-http-shares-live-product-records");
  const participants = app.store.snapshot().bots;
  const group = app.store.createConversation("group", participants.map((participant) => participant.id), "Synthetic project group");
  const tasks = await Promise.all(participants.map((participant) => app!.service.submit({
    submissionId: randomUUID(), botId: participant.id, conversationId: group.id,
    reportConversationId: app!.store.privateConversation(participant.id).id,
    message: "Synthetic group assignment with private reporting",
  })));
  await Promise.all(tasks.map(async (assigned) => assert.equal((await untilTerminal(assigned.id)).status, "completed")));
  for (const assigned of tasks) {
    assert.ok(app.store.messages(assigned.reportConversationId).some((message) =>
      message.id === `report:${assigned.id}` && message.botId === assigned.botId && message.final));
  }
  const catalog = await app.kernel.request<{ sessions: { key: string; kind?: string; chatType?: string }[] }>("sessions.list", {});
  const groupSessions = catalog.sessions.filter((session) => session.key.includes(`:group:${group.id}`));
  assert.equal(groupSessions.length, 2);
  assert.ok(groupSessions.every((session) => session.kind === "group" || session.chatType === "group"));
  evidence.scenarios.push("native-group-classification-and-separate-private-report-delivery");
  const reportGroup = app.store.createConversation("group", participants.map((participant) => participant.id), "Native reporting group");
  const groupFile = await app.service.files!.attach({
    id: randomUUID(), botId: participants[0].id, conversationId: reportGroup.id,
    name: "group-source.txt", mediaType: "text/plain", bytes: Buffer.from("Synthetic shared group attachment"),
  });
  const reportInput = {
    submissionId: randomUUID(), conversationId: reportGroup.id, botIds: participants.map((participant) => participant.id),
    message: "WORKBENCH_GROUP_PRIVATE_REPORT Prepare your work and report privately.",
    attachmentIds: [groupFile.id],
  };
  const groupReceipt = await app.service.submitGroup(reportInput);
  assert.ok(groupReceipt.outcomes.every((outcome) => outcome.accepted));
  for (const outcome of groupReceipt.outcomes) {
    const completed = await untilTerminal(outcome.task.id);
    assert.equal(completed.status, "completed");
    const destination = app.store.privateConversation(outcome.botId);
    assert.equal(completed.reportConversationId, destination.id);
    assert.ok(app.store.messages(destination.id).some((message) =>
      message.id === `report:${completed.id}` && message.botId === outcome.botId));
  }
  const repeated = await app.service.submitGroup(reportInput);
  assert.deepEqual(repeated.outcomes.map((outcome) => outcome.task.id), groupReceipt.outcomes.map((outcome) => outcome.task.id));
  assert.equal(app.store.messages(reportGroup.id).filter((message) => message.role === "user").length, 1);
  const groupEnvelopes = requests.map((request) => (request as { groupHistory?: unknown[] }).groupHistory)
    .filter((history) => history?.length).map((history) => JSON.stringify(history));
  assert.ok(groupEnvelopes.length >= 2 && groupEnvelopes.every((text) =>
    text.includes("group-source.txt") && text.includes("Synthetic shared group attachment") && text.includes("media://inbound/")));
  evidence.scenarios.push("native-group-batch-and-tool-selected-own-private-reporting");
  assignmentTargetId = otherBot.id;
  const coordinator = await app.service.submit({
    submissionId: randomUUID(), conversationId: group.id, botId: bot.id,
    message: "WORKBENCH_COORDINATE Delegate the evidence brief to the other group member and have them report privately.",
  });
  assert.equal((await untilTerminal(coordinator.id)).status, "completed");
  const children = app.store.find<Task>("tasks", "parentTaskId", coordinator.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].botId, otherBot.id);
  assert.equal((await untilTerminal(children[0].id)).status, "completed");
  assert.equal(children[0].reportConversationId, app.store.privateConversation(otherBot.id).id);
  assert.ok(app.store.messages(children[0].reportConversationId).some((message) =>
    message.id === `report:${children[0].id}` && message.botId === otherBot.id));
  assert.ok(app.store.messages(group.id).some((message) =>
    message.taskId === children[0].id && message.role === "assistant" && message.botId === bot.id));
  evidence.scenarios.push("native-bot-to-bot-group-assignment-and-owned-child-private-result");
  const stopParent = await app.service.submit({
    submissionId: randomUUID(), conversationId: group.id, botId: bot.id,
    message: "WORKBENCH_COORDINATE_CANCEL Assign a long-running part to the other member.",
  });
  assert.equal((await untilTerminal(stopParent.id)).status, "completed");
  await Promise.race([childHeld, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Delegated held request did not start")), 15_000); timer.unref();
  })]);
  const liveOther = await app.service.submit({
    submissionId: randomUUID(), conversationId: conversation.id, botId: bot.id,
    message: "WORKBENCH_UNRELATED_LIVE Independent work must remain active.",
  });
  await Promise.race([unrelatedHeld, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Independent held request did not start")), 15_000); timer.unref();
  })]);
  const stopChild = app.store.find<Task>("tasks", "parentTaskId", stopParent.id)[0];
  assert.ok(stopChild);
  await app.service.cancel(stopParent.id);
  assert.equal((await untilTerminal(stopChild.id)).status, "cancelled");
  assert.equal(app.service.task(liveOther.id).status, "running");
  assert.ok(app.store.messages(stopChild.reportConversationId).some((message) =>
    message.id === `report:${stopChild.id}` && message.botId === stopChild.botId && message.final));
  unrelatedRelease();
  assert.equal((await untilTerminal(liveOther.id)).status, "completed");
  evidence.scenarios.push("native-stop-completed-parent-active-child-leaves-unrelated-bot-work-running");
  contextSourceId = group.id;
  const recall = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id,
    message: "WORKBENCH_CONTEXT_ALLOW read our prior group work",
  });
  assert.equal((await untilTerminal(recall.id)).status, "completed");
  const recalledResults = (requests.at(-1) as { toolResults: { content: string }[] }).toolResults;
  assert.ok(recalledResults.some((result) => result.content.includes(group.id) &&
    result.content.includes("Synthetic group assignment with private reporting")));
  assert.ok(recalledResults.some((result) => result.content.includes("botName") &&
    participants.every((participant) => result.content.includes(participant.name)) &&
    tasks.every((assigned) => result.content.includes(assigned.id))));
  evidence.scenarios.push("native-context-tool-reads-permitted-group-from-private-turn");
  const otherPrivate = app.store.privateConversation(otherBot.id);
  contextSourceId = otherPrivate.id;
  const forbidden = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id,
    message: "WORKBENCH_CONTEXT_OTHER_PRIVATE attempt another Bot's private records",
  });
  assert.equal((await untilTerminal(forbidden.id)).status, "completed");
  assert.ok((requests.at(-1) as { toolResults: { content: string }[] }).toolResults
    .some((result) => result.content.includes("Conversation is outside this audience")));
  contextSourceId = conversation.id;
  const groupForbidden = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: group.id,
    message: "WORKBENCH_CONTEXT_GROUP_PRIVATE attempt unshared private records from group",
  });
  assert.equal((await untilTerminal(groupForbidden.id)).status, "completed");
  assert.ok((requests.at(-1) as { toolResults: { content: string }[] }).toolResults
    .some((result) => result.content.includes("Conversation is outside this audience")));
  evidence.scenarios.push("native-context-tool-refuses-other-bot-private-and-unshared-private-in-group");
  const selectedMessage = app.store.messages(conversation.id).find((message) => message.role === "user" && message.final)!;
  const share = app.service.context.share({
    id: randomUUID(), sourceConversationId: conversation.id, destinationConversationId: group.id,
    messageIds: [selectedMessage.id],
  });
  const sharedRecall = await app.service.submit({
    submissionId: randomUUID(), botId: otherBot.id, conversationId: group.id,
    message: "WORKBENCH_CONTEXT_SHARED read the selected private excerpt",
  });
  assert.equal((await untilTerminal(sharedRecall.id)).status, "completed");
  const sharedResults = (requests.at(-1) as { toolResults: { content: string }[] }).toolResults;
  const sharedResult = sharedResults.map((result) => JSON.parse(result.content))
    .find((result) => result.tool?.name === "livingbot_conversations");
  const excerpt = JSON.parse(sharedResult.result.content[0].text);
  assert.equal(excerpt.scope, "shared");
  assert.deepEqual(excerpt.messages.map((message: { messageId: string }) => message.messageId), [selectedMessage.id]);
  assert.equal(excerpt.members, undefined);
  assert.equal(excerpt.tasks, undefined);
  app.service.context.revoke(share.id);
  const revokedRecall = await app.service.submit({
    submissionId: randomUUID(), botId: otherBot.id, conversationId: group.id,
    message: "WORKBENCH_CONTEXT_REVOKED retry private source after sharing stopped",
  });
  assert.equal((await untilTerminal(revokedRecall.id)).status, "completed");
  assert.ok((requests.at(-1) as { toolResults: { content: string }[] }).toolResults
    .some((result) => result.content.includes("Conversation is outside this audience")));
  evidence.scenarios.push("native-group-tool-reads-only-selected-private-excerpt-and-refuses-read-after-revocation");
  const attached = await app.service.files!.attach({
    id: randomUUID(), botId: bot.id, conversationId: conversation.id,
    name: "contract-input.txt", mediaType: "text/plain", bytes: Buffer.from(attachmentText),
  });
  attachedPath = attached.path;
  const fileTask = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: conversation.id,
    message: "WORKBENCH_FILES read the attachment and deliver a markdown result", attachmentIds: [attached.id],
  });
  assert.equal((await untilTerminal(fileTask.id)).status, "completed");
  assert.equal(fileStep, 3);
  const fileEnvelope = requests.map((request) => (request as { fileHistory?: unknown[] }).fileHistory)
    .filter((history) => history?.length).map((history) => JSON.stringify(history)).join("\n");
  assert.ok(fileEnvelope.includes("media://inbound/") && fileEnvelope.includes("contract-input.txt") &&
    fileEnvelope.includes(attachmentText));
  const delivered = app.store.list<Artifact>("artifacts").find((file) => file.taskId === fileTask.id)!;
  assert.ok(delivered);
  assert.equal((await app.service.files!.read(delivered.id)).bytes.toString(), attachmentText);
  assert.ok(app.store.messages(conversation.id).some((message) => message.taskId === fileTask.id &&
    message.blocks.some((block) => block.kind === "file" && block.artifactId === delivered.id)));
  const downloaded = await fetch(`${app.url}/api/files/${delivered.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), attachmentText);
  evidence.scenarios.push("native-attachment-read-file-write-delivery-and-authenticated-download");
  const recoveringConversation = app.store.createConversation("private", [bot.id], "Synthetic restart continuation");
  const interrupted = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: recoveringConversation.id,
    message: "WORKBENCH_HOLD synthetic restart task",
  });
  await Promise.race([held, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Held model request did not start")), 15_000); timer.unref();
  })]);
  const queued = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: recoveringConversation.id,
    message: "WORKBENCH_QUEUED synthetic retained followup",
  });
  await app.kernel.restart();
  await Promise.all([interrupted, queued].map(async (assigned) =>
    assert.equal((await untilTerminal(assigned.id)).status, "completed")));
  await app.service.reconcile();
  assert.equal(app.store.messages(recoveringConversation.id).filter((message) => message.role === "user").length, 2);
  evidence.scenarios.push("active-turn-graceful-restart-new-continuation-and-retained-followup-complete");
  const questionConversation = app.store.createConversation("private", [bot.id], "Synthetic interactive question");
  const questionTask = await app.service.submit({
    submissionId: randomUUID(), botId: bot.id, conversationId: questionConversation.id,
    message: "WORKBENCH_QUESTION synthetic question and continuation",
  });
  const prompt = await untilQuestion(questionTask.id);
  assert.equal(app.service.task(questionTask.id).status, "waiting");
  assert.equal(prompt.questions[0].options.length, 2);
  await app.service.interactions.recover();
  const answered = await app.service.interactions.resolve(prompt.id, questionTask.id, {
    resolutionId: randomUUID(), answers: { [prompt.questions[0].id]: [prompt.questions[0].options[0].value] },
  });
  assert.equal(answered.status, "answered");
  assert.equal((await untilTerminal(questionTask.id)).status, "completed");
  evidence.scenarios.push("native-ask-user-recovery-answer-and-original-turn-continuation");
  for (const decision of ["allow", "deny"] as const) {
    const approvalConversation = app.store.createConversation("private", [bot.id], `Synthetic approval ${decision}`);
    const approvalTask = await app.service.submit({
      submissionId: randomUUID(), botId: bot.id, conversationId: approvalConversation.id,
      message: `WORKBENCH_APPROVAL_${decision.toUpperCase()}`,
    });
    const approval = await untilQuestion(approvalTask.id, "approval");
    await app.service.interactions.resolve(approval.id, approvalTask.id, {
      resolutionId: randomUUID(), decision: decision === "allow" ? "allow-once" : "deny",
    });
    assert.equal((await untilTerminal(approvalTask.id)).status, "completed");
    const marker = join(paths.workspaces, bot.agentId, `approval-marker-${decision}`);
    if (decision === "allow") await access(marker);
    else await assert.rejects(access(marker), { code: "ENOENT" });
    evidence.scenarios.push(`native-exec-approval-${decision}-actual-file-effect`);
  }
  const failureConversation = app.store.createConversation("private", [bot.id], "Synthetic provider rejection");
  const failureTask = await app.service.submit({
    submissionId: randomUUID(), conversationId: failureConversation.id, botId: bot.id,
    message: "WORKBENCH_PROVIDER_FAILURE",
  });
  const failure = await untilTerminal(failureTask.id);
  assert.equal(failure.status, "failed");
  assert.ok(failure.error);
  const failureReplies = app.store.messages(failureConversation.id).filter((message) => message.role === "assistant");
  assert.equal(failureReplies.length, 1);
  assert.ok(failureReplies[0].final);
  for (const event of ["agent:lifecycle", "agent:assistant", "agent:tool", "chat:final", "chat:error"]) {
    assert.ok(nativeEvents.has(event), `Missing official native event: ${event}`);
  }
  evidence.scenarios.push("official-assistant-tool-lifecycle-final-and-provider-error-events-own-visible-outcomes");
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  unrelatedRelease();
  if (app) await app.close();
  await new Promise<void>((resolve, reject) => model.close((error) => error ? reject(error) : resolve()));
  evidence.nativeEvents = [...nativeEvents].sort();
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ root, scenarios: evidence.scenarios, error: evidence.error }, null, 2));
}
