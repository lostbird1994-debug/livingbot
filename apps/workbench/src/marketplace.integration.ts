import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchWorkbench } from "./main.ts";
import { OpenClawCapabilities } from "../../../packages/kernel-runtime/src/capabilities.ts";
import { OpenClawAgents } from "../../../packages/kernel-runtime/src/agents.ts";
import { Workspaces } from "../../../packages/workbench/src/workspaces.ts";
import { Marketplace } from "../../../packages/workbench/src/marketplace.ts";
import type { BotPackage } from "../../../packages/workbench/src/marketplace.ts";
import type { Task } from "../../../packages/workbench/src/contracts.ts";

const { values } = parseArgs({ options: { "kernel-entry": { type: "string" } } });
if (!values["kernel-entry"]) throw new Error("--kernel-entry is required");
await mkdir("local/test-fixtures", { recursive: true });
const root = await mkdtemp(resolve("local/test-fixtures/native-marketplace-"));
const requests: { messages?: unknown[] }[] = [];
const model = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "Synthetic installed Bot result." }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "synthetic",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
const bundle: BotPackage = {
  format: "livingbot-package-v1", id: "synthetic-researcher", kind: "bot", name: "Example researcher",
  description: "Synthetic installed research method", author: "Example author", version: "1.0.0", license: "MIT",
  permissions: ["Read selected workspace documents"],
  files: [
    { path: "SOUL.md", text: "# Public identity\n\nSYNTHETIC_MARKET_IDENTITY: cite inspected sources." },
    { path: "skills/research/SKILL.md", text: "---\nname: research\ndescription: Produce a source-grounded synthetic research report\n---\nSYNTHETIC_MARKET_METHOD: separate observation from inference." },
  ],
};
const source = { repository: "example/methods", path: "livingbot.json", commit: "a".repeat(40), blob: "b".repeat(40) };
let app: Awaited<ReturnType<typeof launchWorkbench>> | undefined;
let failure: string | undefined;
const scenarios: string[] = [];
let installed: unknown;
function market() {
  return new Marketplace(app!.store, { read: async () => ({
    source: { ...source, commit: bundle.version === "2.0.0" ? "c".repeat(40) : source.commit },
    bytes: Buffer.from(JSON.stringify(bundle)),
  }) }, {
    workspaces: new Workspaces(app!.paths.workspaces), registration: new OpenClawAgents(app!.kernel),
    capabilities: new OpenClawCapabilities(app!.kernel),
    withChanges: (botId, action) => app!.service.abilities!.withChanges(botId, action),
  });
}
try {
  app = await launchWorkbench({
    root: join(root, "application"), nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]),
    connection: { id: "synthetic", baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      api: "openai-completions", apiKey: "synthetic", model: "synthetic", contextWindow: 64_000, maxTokens: 1000 },
  });
  const marketplace = market();
  const preview = await marketplace.preview({ repository: source.repository });
  const installation = await marketplace.install({ previewId: preview.id, digest: preview.digest });
  installed = installation;
  assert.equal(installation.state, "ready");
  const native = await new OpenClawCapabilities(app.kernel).read(installation.agentId, `agent:${installation.agentId}:main`);
  assert.ok(native.some((item) => item.nativeKind === "skill" && installation.skills.includes(item.nativeName) && item.enabled && item.ready));
  assert.equal(await readFile(join(app.paths.workspaces, installation.agentId, "SOUL.md"), "utf8"), bundle.files[0].text);
  scenarios.push("reviewed-package-creates-an-independent-native-agent-with-visible-enabled-method");
  const conversation = app.store.privateConversation(installation.botId);
  const task = await app.service.submit({
    submissionId: randomUUID(), botId: installation.botId, conversationId: conversation.id,
    message: "Prepare a synthetic research report using the installed method.",
  });
  await new Promise<void>((done, reject) => {
    const store = app!.store;
    const timer = setTimeout(() => { store.off("event", changed); reject(new Error("Installed Bot did not finish")); }, 30_000);
    function changed() {
      if (store.get<Task>("tasks", task.id)?.status !== "completed") return;
      clearTimeout(timer); store.off("event", changed); done();
    }
    store.on("event", changed); changed();
  });
  assert.ok(JSON.stringify(requests[0].messages).includes("SYNTHETIC_MARKET_IDENTITY"));
  assert.ok(JSON.stringify(requests[0].messages).includes(installation.skills[0]));
  scenarios.push("installed-bot-runs-through-native-kernel-with-package-identity-and-method-inventory");
  await app.close();
  app = await launchWorkbench({ root: join(root, "application"), nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]) });
  assert.deepEqual(await market().install({ previewId: preview.id, digest: preview.digest }), installation);
  assert.equal(app.store.get<Task>("tasks", task.id)?.status, "completed");
  assert.equal(requests.length, 1);
  scenarios.push("package-installation-native-agent-method-and-task-survive-product-restart-without-duplicate-work");
  const workspace = new Workspaces(app.paths.workspaces);
  await workspace.write(installation.agentId, "memory", "retained.md", "Synthetic private memory retained");
  const memory = await workspace.read(installation.agentId, "memory/retained.md", 10000);
  const revoked = await market().setEnabled(installation.id, false);
  assert.equal(revoked.state, "revoked");
  const revokedInventory = await new OpenClawCapabilities(app.kernel).read(installation.agentId, `agent:${installation.agentId}:main`);
  assert.ok(revokedInventory.some((item) => item.nativeName === installation.skills[0] && !item.enabled));
  assert.equal(app.store.get<Task>("tasks", task.id)?.status, "completed");
  assert.ok(app.store.get("bots", installation.botId));
  assert.deepEqual(await workspace.read(installation.agentId, "memory/retained.md", 10000), memory);
  assert.equal(await readFile(join(app.paths.workspaces, installation.agentId, "SOUL.md"), "utf8"), bundle.files[0].text);
  scenarios.push("revocation-confirms-native-method-disabled-and-retains-identity-memory-conversation-and-result");
  await app.close();
  app = await launchWorkbench({ root: join(root, "application"), nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]) });
  assert.equal(market().installations()[0].state, "revoked");
  const restored = await market().setEnabled(installation.id, true);
  assert.equal(restored.state, "ready");
  assert.equal(restored.botId, installation.botId);
  const restoredInventory = await new OpenClawCapabilities(app.kernel).read(installation.agentId, `agent:${installation.agentId}:main`);
  assert.ok(restoredInventory.some((item) => item.nativeName === installation.skills[0] && item.enabled && item.ready));
  assert.equal(requests.length, 1);
  scenarios.push("revoked-state-survives-restart-and-native-method-restores-without-new-agent-or-model-call");
  const oldIdentity = bundle.files[0].text;
  bundle.version = "2.0.0";
  bundle.files = bundle.files.map((file) => ({ ...file, text: `${file.text}\nSYNTHETIC_UPDATED_PUBLIC_INSTRUCTIONS` }));
  const updatedPreview = await market().preview({ repository: source.repository });
  const updateInput = {
    id: installation.id, expectedDigest: installation.digest, previewId: updatedPreview.id,
    digest: updatedPreview.digest, replaceIdentity: true,
  };
  const updated = await market().update(updateInput);
  assert.equal(updated.state, "ready");
  assert.equal(updated.version, "2.0.0");
  assert.equal(updated.agentId, installation.agentId);
  assert.equal(updated.botId, installation.botId);
  const updatedInventory = await new OpenClawCapabilities(app.kernel).read(updated.agentId, `agent:${updated.agentId}:main`);
  assert.ok(updatedInventory.some((item) => item.nativeName === updated.skills[0] && item.enabled && item.ready));
  assert.ok(updatedInventory.some((item) => item.nativeName === installation.skills[0] && !item.enabled));
  const receipt = market().updates()[0];
  assert.equal((await workspace.read(updated.agentId, receipt.identityBackup!, 10000)).toString(), oldIdentity);
  assert.equal((await workspace.read(updated.agentId, "SOUL.md", 10000)).toString(), bundle.files[0].text);
  assert.deepEqual(await workspace.read(updated.agentId, "memory/retained.md", 10000), memory);
  assert.equal(app.store.privateConversation(updated.botId).id, conversation.id);
  assert.equal(app.store.get<Task>("tasks", task.id)?.status, "completed");
  scenarios.push("reviewed-version-update-retains-agent-chat-memory-and-old-methods-with-verified-public-identity-backup");
  await app.close();
  app = await launchWorkbench({ root: join(root, "application"), nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]) });
  assert.deepEqual(await market().update(updateInput), updated);
  assert.equal(market().updates()[0].state, "ready");
  assert.equal(requests.length, 1);
  scenarios.push("reviewed-update-receipt-and-native-version-survive-restart-and-retry-without-duplicate-work");
  const methods = await market().shareableMethods(updated.botId);
  const method = methods.find((item) => item.id === updated.skills[0])!;
  assert.ok(method);
  const { format: _format, files: _files, ...publicMetadata } = bundle;
  const share = await market().prepareShare({
    botId: updated.botId, metadata: { ...publicMetadata, kind: "ability" },
    paths: method.files.map((file) => file.path),
  });
  const exported = market().exportShare(share.id, share.digest);
  assert.equal(exported.package.files.length, 1);
  assert.ok(!JSON.stringify(exported).includes("Synthetic private memory retained"));
  assert.ok(!JSON.stringify(exported).includes("SYNTHETIC_MARKET_IDENTITY"));
  scenarios.push("selected-installed-method-exports-reviewed-documents-without-private-memory-or-bot-identity");
  const other = app.store.snapshot().bots.find((bot) => bot.id !== updated.botId)!;
  const importedMarket = new Marketplace(app.store, { read: async () => ({
    source: { repository: "example/shared-methods", commit: "d".repeat(40), blob: "e".repeat(40), path: exported.filename },
    bytes: Buffer.from(JSON.stringify(exported.package)),
  }) }, {
    workspaces: new Workspaces(app.paths.workspaces), registration: new OpenClawAgents(app.kernel),
    capabilities: new OpenClawCapabilities(app.kernel),
    withChanges: (botId, action) => app!.service.abilities!.withChanges(botId, action),
  });
  const importPreview = await importedMarket.preview({ repository: "example/shared-methods", path: exported.filename });
  const imported = await importedMarket.install({ previewId: importPreview.id, digest: importPreview.digest, botId: other.id });
  assert.equal(imported.botId, other.id);
  assert.equal(imported.agentId, other.agentId);
  assert.equal(app.store.snapshot().bots.length, 2);
  const importedInventory = await new OpenClawCapabilities(app.kernel).read(other.agentId, `agent:${other.agentId}:main`);
  assert.ok(importedInventory.some((item) => item.nativeName === imported.skills[0] && item.enabled && item.ready));
  scenarios.push("shared-method-package-reinstalls-into-another-existing-native-agent-without-creating-a-bot");
  await app.close();
  app = await launchWorkbench({ root: join(root, "application"), nodeExecutable: process.execPath, kernelEntry: resolve(values["kernel-entry"]) });
  assert.deepEqual(market().exportShare(share.id, share.digest), exported);
  assert.ok(market().installations().some((item) => item.botId === other.id && item.digest === importPreview.digest && item.state === "ready"));
  assert.equal(requests.length, 1);
  scenarios.push("reviewed-share-and-reinstalled-native-method-retain-their-identities-across-full-restart");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  if (app) await app.close();
  model.closeAllConnections();
  await new Promise<void>((done) => model.close(() => done()));
  await writeFile(join(root, "evidence.json"), JSON.stringify({ scenarios, failure, installed, requests }, null, 2), { mode: 0o600, flag: "wx" });
  console.log({ root, scenarios, failure });
}
