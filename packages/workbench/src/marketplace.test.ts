import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { botPackage, GitHubPackages, Marketplace } from "./marketplace.ts";
import { WorkbenchStore } from "./store.ts";
import { Workspaces } from "./workspaces.ts";
import type { KernelCapability } from "../../kernel-runtime/src/capabilities.ts";

function sample() {
  return {
    format: "livingbot-package-v1", id: "example-researcher", kind: "bot", name: "Example researcher",
    description: "A synthetic source-grounded research method", version: "1.0.0", license: "MIT", author: "Example author",
    permissions: ["Read selected project documents"],
    files: [
      { path: "SOUL.md", text: "Only claim findings supported by sources." },
      { path: "skills/research/SKILL.md", text: "---\nname: research\ndescription: Research a selected topic\n---\nCite inspected sources." },
      { path: "skills/research/references/guide.md", text: "Separate observation from interpretation." },
    ],
  };
}
const commit = "a".repeat(40);
const tree = "b".repeat(40);
function gitFixture(options: { mode?: string; truncated?: boolean; corrupt?: boolean; declaredSize?: number } = {}) {
  const bytes = Buffer.from(JSON.stringify(sample()));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const calls: { path: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (target, init) => {
    const path = new URL(String(target)).pathname;
    calls.push({ path, options: init });
    let data: unknown;
    if (path.endsWith("/commits/main")) data = { sha: commit, commit: { tree: { sha: tree } } };
    else if (path.endsWith(`/git/trees/${tree}`)) data = {
      sha: tree, truncated: options.truncated ?? false,
      tree: [{ path: "livingbot.json", type: "blob", mode: options.mode ?? "100644", sha: blob, size: bytes.length }],
    };
    else if (path.endsWith(`/git/blobs/${blob}`)) data = {
      sha: blob, encoding: "base64", size: options.declaredSize ?? bytes.length,
      content: (options.corrupt ? Buffer.from("different bytes") : bytes).toString("base64"),
    };
    else return new Response("not found", { status: 404 });
    return Response.json(data);
  };
  return { provider: new GitHubPackages(fetcher), calls, blob, bytes };
}

test("GitHub package reads pin a branch to immutable objects and verify the actual Git blob", async () => {
  const f = gitFixture();
  const result = await f.provider.read({ repository: "example/methods", ref: "main" });
  assert.deepEqual(result.source, { repository: "example/methods", commit, blob: f.blob, path: "livingbot.json" });
  assert.deepEqual(Buffer.from(result.bytes), f.bytes);
  assert.deepEqual(f.calls.map((call) => call.path), [
    "/repos/example/methods/commits/main",
    `/repos/example/methods/git/trees/${tree}`,
    `/repos/example/methods/git/blobs/${f.blob}`,
  ]);
  assert.ok(f.calls.every((call) => call.options?.redirect === "error"));
});

test("package reads reject links, executables, truncated trees and changed bytes", async () => {
  for (const options of [{ mode: "120000" }, { mode: "100755" }, { truncated: true }, { corrupt: true }, { declaredSize: 1 }]) {
    await assert.rejects(gitFixture(options).provider.read({ repository: "example/methods", ref: "main" }));
  }
});

test("repository and path validation prevents alternate hosts and traversal before network reads", async () => {
  const f = gitFixture();
  for (const repository of ["https://example.invalid/pkg", "owner/../other", "owner/repo?token=secret"]) {
    await assert.rejects(f.provider.read({ repository }));
  }
  for (const path of ["../livingbot.json", "x/../../livingbot.json", "/livingbot.json", "x\\livingbot.json", ".hidden/livingbot.json"]) {
    await assert.rejects(f.provider.read({ repository: "example/methods", path }));
  }
  assert.equal(f.calls.length, 0);
});

test("package format refuses execution, private data, unknown fields and ambiguous paths", () => {
  const bundle = sample();
  for (const path of ["memory/MEMORY.md", "USER.md", ".env", "skills/research/run.sh", "skills/research/../SKILL.md",
    "skills/research/references/start.js", "skills/research/references/.env"]) {
    assert.throws(() => botPackage({ ...bundle, files: [...bundle.files, { path, text: "Do not package this." }] }));
  }
  assert.throws(() => botPackage({ ...bundle, hooks: { install: "echo bad" } }), /Unknown/);
  assert.throws(() => botPackage({ ...bundle, files: [...bundle.files, bundle.files[0]] }), /Duplicate/);
  assert.throws(() => botPackage({ ...bundle, files: bundle.files.filter((file) => !file.path.endsWith("SKILL.md")) }), /require/);
  assert.throws(() => botPackage({ ...bundle, version: "main" }), /version/);
  assert.throws(() => botPackage({ ...bundle, files: [{ path: "SOUL.md", text: "x".repeat(100_001) }] }), /document/);
});

test("preview stores the reviewed content, survives reopen and does not follow a changed branch", async () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const f = gitFixture();
    const market = new Marketplace(store, f.provider);
    const preview = await market.preview({ repository: "example/methods", ref: "main" });
    assert.equal(preview.source.commit, commit);
    const reopened = new Marketplace(store, { read: async () => { throw new Error("Network must not run"); } });
    assert.deepEqual(reopened.get(preview.id), preview);
    const record = store.get<Record<string, unknown>>("settings", `package-preview:${preview.id}`)!;
    store.put("settings", { ...record, id: `package-preview:${preview.id}`, package: { ...preview.package, description: "Changed after review" } });
    assert.throws(() => reopened.get(preview.id), /changed/);
    assert.equal(store.list("bots").length, 0);
  } finally { store.close(); }
});

test("author exports preserve only explicitly selected public package fields and method documents", () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const bot = store.createBot({ name: "Private example", agentId: "private-example", identity: "Private identity must not be scanned" });
    store.privateConversation(bot.id);
    const market = new Marketplace(store, gitFixture().provider);
    const result = market.export(sample());
    assert.equal(result.filename, "example-researcher-1.0.0.livingbot.json");
    assert.equal(result.digest.length, 64);
    assert.ok(!JSON.stringify(result).includes("Private identity"));
    assert.throws(() => market.export({ ...sample(), conversations: [{ text: "private" }] }), /Unknown/);
  } finally { store.close(); }
});

async function installerFixture() {
  await mkdir(resolve("local/test-fixtures"), { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/marketplace-"));
  const store = new WorkbenchStore(`${root}/journal.sqlite`);
  const workspaces = new Workspaces(`${root}/workspaces`);
  const registrations: string[] = [];
  const enabled = new Set<string>();
  let fail = false;
  let failAccess = false;
  let bundle = sample();
  const repository = { read: async () => ({
    source: { repository: "example/methods", commit, path: "livingbot.json", blob: "c".repeat(40) },
    bytes: Buffer.from(JSON.stringify(bundle)),
  }) };
  const installer = {
    workspaces,
    registration: { ensure: async (input: { agentId: string }) => {
      if (fail) throw new Error("Synthetic lost registration");
      registrations.push(input.agentId);
    } },
    capabilities: {
      read: async (agentId: string): Promise<KernelCapability[]> => {
        const names = await readdir(`${root}/workspaces/${agentId}/skills`);
        return names.map((name) => ({
          id: name, name, nativeName: name, nativeKind: "skill", kind: "method", description: "Synthetic method",
          source: "workspace", enabled: enabled.has(name), ready: true, manageable: true,
        }));
      },
      setEnabled: async (_agentId: string, capability: KernelCapability, value: boolean) => {
        if (failAccess) throw new Error("Synthetic access change unavailable");
        if (value) enabled.add(capability.nativeName); else enabled.delete(capability.nativeName);
      },
    },
  };
  return { root, store, repository, installer, registrations, enabled,
    bundle: (value: ReturnType<typeof sample>) => { bundle = value; },
    fail: (value: boolean) => { fail = value; }, failAccess: (value: boolean) => { failAccess = value; } };
}

test("review-bound Bot installation writes an isolated identity and methods once and retains its native ownership", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const preview = await market.preview({ repository: "example/methods" });
    assert.throws(() => market.install({ previewId: preview.id, digest: "wrong" }), /exact/);
    const [installed, repeated] = await Promise.all([
      market.install({ previewId: preview.id, digest: preview.digest }),
      market.install({ previewId: preview.id, digest: preview.digest }),
    ]);
    assert.deepEqual(installed, repeated);
    assert.equal(installed.state, "ready");
    assert.equal(f.store.list("bots").length, 1);
    assert.equal(f.registrations.length, 1);
    assert.equal(await readFile(`${f.root}/workspaces/${installed.agentId}/SOUL.md`, "utf8"), sample().files[0].text);
    const method = await f.installer.workspaces.read(installed.agentId, `skills/${installed.skills[0]}/SKILL.md`, 10000);
    assert.ok(method.toString().includes(`name: ${installed.skills[0]}`));
    assert.ok(f.enabled.has(installed.skills[0]));
    const reopened = new Marketplace(f.store, f.repository, f.installer);
    assert.deepEqual(await reopened.install({ previewId: preview.id, digest: preview.digest }), installed);
    assert.equal(f.registrations.length, 1);
  } finally { f.store.close(); }
});

test("failed registration keeps unpublished package data and resumes the same installation without duplicates", async () => {
  const f = await installerFixture();
  let originalClosed = false;
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const preview = await market.preview({ repository: "example/methods" });
    f.fail(true);
    await assert.rejects(market.install({ previewId: preview.id, digest: preview.digest }), /registration/);
    const receipt = market.installations()[0];
    assert.equal(receipt.state, "failed");
    assert.equal(f.store.list("bots").length, 0);
    f.fail(false);
    f.store.close();
    originalClosed = true;
    const reopenedStore = new WorkbenchStore(`${f.root}/journal.sqlite`);
    try {
      const reopened = new Marketplace(reopenedStore, {
        read: async () => { throw new Error("Retry must not fetch the repository again"); },
      }, f.installer);
      const retained = reopened.get(receipt.previewId);
      assert.equal(retained.digest, receipt.digest);
      const done = await reopened.install({ previewId: retained.id, digest: retained.digest });
      assert.equal(done.id, receipt.id);
      assert.equal(done.botId, receipt.botId);
      assert.equal(done.agentId, receipt.agentId);
      assert.equal(done.state, "ready");
      assert.equal(reopenedStore.list("bots").length, 1);
    } finally { reopenedStore.close(); }
  } finally { if (!originalClosed) f.store.close(); }
});

test("package revocation confirms native method access, preserves Bot data and restores without reinstalling", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const preview = await market.preview({ repository: "example/methods" });
    const installed = await market.install({ previewId: preview.id, digest: preview.digest });
    const before = f.store.snapshot();
    const soul = await f.installer.workspaces.read(installed.agentId, "SOUL.md", 10000);
    await f.installer.workspaces.write(installed.agentId, "memory", "private.md", "Private memory retained");
    const [revoked, duplicate] = await Promise.all([
      market.setEnabled(installed.id, false), market.setEnabled(installed.id, false),
    ]);
    assert.deepEqual(revoked, duplicate);
    assert.equal(revoked.state, "revoked");
    assert.equal(f.enabled.size, 0);
    assert.deepEqual(f.store.snapshot().bots, before.bots);
    assert.deepEqual(f.store.snapshot().conversations, before.conversations);
    assert.deepEqual(await f.installer.workspaces.read(installed.agentId, "SOUL.md", 10000), soul);
    assert.equal((await f.installer.workspaces.read(installed.agentId, "memory/private.md", 10000)).toString(), "Private memory retained");
    const reopened = new Marketplace(f.store, f.repository, f.installer);
    const restored = await reopened.setEnabled(installed.id, true);
    assert.equal(restored.state, "ready");
    assert.equal(restored.botId, installed.botId);
    assert.equal(f.registrations.length, 1);
    assert.ok(f.enabled.has(installed.skills[0]));
  } finally { f.store.close(); }
});

test("failed revocation remains visibly unfinished and can retry after restart without losing ownership", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const preview = await market.preview({ repository: "example/methods" });
    const installed = await market.install({ previewId: preview.id, digest: preview.digest });
    f.failAccess(true);
    await assert.rejects(market.setEnabled(installed.id, false), /unavailable/);
    assert.equal(market.installations()[0].state, "revoking");
    assert.ok(f.enabled.has(installed.skills[0]));
    assert.throws(() => market.setEnabled(installed.id, true), /Retry/);
    assert.throws(() => market.install({ previewId: preview.id, digest: preview.digest }), /access control/);
    f.failAccess(false);
    const reopened = new Marketplace(f.store, f.repository, f.installer);
    assert.equal((await reopened.setEnabled(installed.id, false)).state, "revoked");
    assert.equal(f.enabled.size, 0);
    assert.equal(f.store.list("bots").length, 1);
  } finally { f.store.close(); }
});

test("reviewed version updates retain the agent, private memory and old methods and verify identity backup before replacement", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const oldPreview = await market.preview({ repository: "example/methods" });
    const old = await market.install({ previewId: oldPreview.id, digest: oldPreview.digest });
    const conversation = f.store.privateConversation(old.botId);
    await f.installer.workspaces.write(old.agentId, "memory", "private.md", "Retained private memory");
    const next = { ...sample(), version: "2.0.0", files: sample().files.map((file) => ({ ...file, text: `${file.text}\nNew public method instructions.` })) };
    f.bundle(next);
    const preview = await market.preview({ repository: "example/methods" });
    const input = { id: old.id, expectedDigest: old.digest, previewId: preview.id, digest: preview.digest, replaceIdentity: true };
    assert.throws(() => market.update({ ...input, expectedDigest: "wrong" }), /changed/);
    const updated = await market.update(input);
    assert.equal(updated.version, "2.0.0");
    assert.equal(updated.botId, old.botId);
    assert.equal(updated.agentId, old.agentId);
    assert.equal(f.store.privateConversation(old.botId).id, conversation.id);
    assert.equal(f.store.list("bots").length, 1);
    assert.ok(!f.enabled.has(old.skills[0]));
    assert.ok(f.enabled.has(updated.skills[0]));
    assert.ok((await f.installer.workspaces.read(old.agentId, `skills/${old.skills[0]}/SKILL.md`, 10000)).length);
    assert.equal((await f.installer.workspaces.read(old.agentId, "memory/private.md", 10000)).toString(), "Retained private memory");
    assert.equal((await f.installer.workspaces.read(old.agentId, "SOUL.md", 10000)).toString(), next.files[0].text);
    const receipt = market.updates()[0];
    assert.equal(receipt.state, "ready");
    assert.equal((await f.installer.workspaces.read(old.agentId, receipt.identityBackup!, 10000)).toString(), sample().files[0].text);
    assert.deepEqual(await new Marketplace(f.store, f.repository, f.installer).update(input), updated);
    assert.equal(f.registrations.length, 2);
  } finally { f.store.close(); }
});

test("failed updates stay retryable across restart without duplicating Bots or replacing private identity", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const oldPreview = await market.preview({ repository: "example/methods" });
    const old = await market.install({ previewId: oldPreview.id, digest: oldPreview.digest });
    f.bundle({ ...sample(), version: "2.0.0" });
    const preview = await market.preview({ repository: "example/methods" });
    const input = { id: old.id, expectedDigest: old.digest, previewId: preview.id, digest: preview.digest, replaceIdentity: false };
    f.failAccess(true);
    await assert.rejects(market.update(input), /unavailable/);
    assert.equal(market.updates()[0].state, "failed");
    assert.equal(market.installations()[0].version, "1.0.0");
    assert.throws(() => market.setEnabled(old.id, false), /update first/);
    f.failAccess(false);
    const reopened = new Marketplace(f.store, f.repository, f.installer);
    const updated = await reopened.update(input);
    assert.equal(updated.version, "2.0.0");
    assert.equal(updated.agentId, old.agentId);
    assert.equal(reopened.updates()[0].state, "ready");
    assert.equal((await f.installer.workspaces.read(old.agentId, "SOUL.md", 10000)).toString(), sample().files[0].text);
    assert.equal(f.store.list("bots").length, 1);
  } finally { f.store.close(); }
});

test("locally edited public identity blocks replacement and the reviewed update can explicitly retain that identity", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const oldPreview = await market.preview({ repository: "example/methods" });
    const old = await market.install({ previewId: oldPreview.id, digest: oldPreview.digest });
    await writeFile(`${f.root}/workspaces/${old.agentId}/SOUL.md`, "Locally edited synthetic identity");
    f.bundle({ ...sample(), version: "2.0.0" });
    const preview = await market.preview({ repository: "example/methods" });
    const input = { id: old.id, expectedDigest: old.digest, previewId: preview.id, digest: preview.digest, replaceIdentity: true };
    await assert.rejects(market.update(input), /edited locally/);
    assert.equal(market.updates()[0].identityBackup, undefined);
    assert.equal(market.installations()[0].version, "1.0.0");
    const result = await market.update({ ...input, replaceIdentity: false });
    assert.equal(result.version, "2.0.0");
    assert.equal(market.updates().length, 1);
    assert.equal((await f.installer.workspaces.read(old.agentId, "SOUL.md", 10000)).toString(), "Locally edited synthetic identity");
  } finally { f.store.close(); }
});

test("a corrupted retained identity backup prevents retry from replacing the original Bot identity", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const oldPreview = await market.preview({ repository: "example/methods" });
    const old = await market.install({ previewId: oldPreview.id, digest: oldPreview.digest });
    f.bundle({ ...sample(), version: "2.0.0", files: sample().files.map((file) => ({ ...file, text: `${file.text}\nUpdated.` })) });
    const preview = await market.preview({ repository: "example/methods" });
    const input = { id: old.id, expectedDigest: old.digest, previewId: preview.id, digest: preview.digest, replaceIdentity: true };
    f.failAccess(true);
    await assert.rejects(market.update(input), /unavailable/);
    const backup = market.updates()[0].identityBackup!;
    await writeFile(`${f.root}/workspaces/${old.agentId}/${backup}`, "Synthetic corrupted backup");
    f.failAccess(false);
    await assert.rejects(new Marketplace(f.store, f.repository, f.installer).update(input), /backup verification/);
    assert.equal((await f.installer.workspaces.read(old.agentId, "SOUL.md", 10000)).toString(), sample().files[0].text);
    assert.equal(market.installations()[0].version, "1.0.0");
    assert.equal(market.updates()[0].state, "failed");
  } finally { f.store.close(); }
});

test("selective sharing reads only selected Bot method files and downloads the reviewed snapshot after source edits", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const preview = await market.preview({ repository: "example/methods" });
    const installed = await market.install({ previewId: preview.id, digest: preview.digest });
    await f.installer.workspaces.write(installed.agentId, "memory", "private.md", "PRIVATE_MEMORY_NOT_FOR_EXPORT");
    const other = f.store.createBot({ name: "Another", agentId: "another" });
    await f.installer.workspaces.write(other.agentId, "skills", "private-method/SKILL.md", "---\nname: private-method\ndescription: Private method\n---\nOTHER_BOT_CONTENT");
    const reads: string[] = [];
    const originalRead = f.installer.workspaces.read.bind(f.installer.workspaces);
    f.installer.workspaces.read = async (agentId, path, max) => {
      reads.push(`${agentId}/${path}`);
      return originalRead(agentId, path, max);
    };
    const methods = await market.shareableMethods(installed.botId);
    assert.equal(reads.length, 0);
    assert.equal(methods.length, 1);
    assert.equal(methods[0].name, "research");
    const paths = methods[0].files.map((file) => file.path);
    const { format: _format, files: _files, ...metadata } = sample();
    const share = await market.prepareShare({ botId: installed.botId, metadata, paths, identity: "Explicit public identity" });
    assert.deepEqual(reads.sort(), paths.map((path) => `${installed.agentId}/${path}`).sort());
    assert.equal(share.package.files.length, 3);
    assert.ok(!JSON.stringify(share).includes("PRIVATE_MEMORY_NOT_FOR_EXPORT"));
    assert.ok(!JSON.stringify(share).includes("OTHER_BOT_CONTENT"));
    assert.equal(share.package.files.find((file) => file.path === "SOUL.md")!.text, "Explicit public identity");
    const methodPath = paths.find((path) => path.endsWith("SKILL.md"))!;
    await writeFile(`${f.root}/workspaces/${installed.agentId}/${methodPath}`, "Changed after public preview");
    const reopened = new Marketplace(f.store, f.repository, f.installer);
    assert.throws(() => reopened.exportShare(share.id, "wrong"), /exact/);
    assert.deepEqual(reopened.exportShare(share.id, share.digest).package, share.package);
    assert.ok(!JSON.stringify(reopened.exportShare(share.id, share.digest)).includes("Changed after public preview"));
    await assert.rejects(market.prepareShare({ botId: installed.botId, metadata, paths: ["memory/private.md"], identity: "Public" }), /method documents/);
  } finally { f.store.close(); }
});

test("sharing reports unsupported files and links without following them and supports a methods-only package", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const bot = f.store.createBot({ name: "Local methods", agentId: "local-methods" });
    await f.installer.workspaces.write(bot.agentId, "skills", "research/SKILL.md", sample().files[1].text);
    await f.installer.workspaces.write(bot.agentId, "skills", "research/references/guide.md", "Selected reference");
    await f.installer.workspaces.write(bot.agentId, "skills", "research/scripts/run.sh", "Synthetic unsupported script");
    const privatePath = await f.installer.workspaces.write(bot.agentId, "memory", "private.md", "Link target remains private");
    await symlink(privatePath, `${f.root}/workspaces/${bot.agentId}/skills/research/references/link.md`);
    const methods = await market.shareableMethods(bot.id);
    assert.deepEqual(methods[0].files.map((file) => file.path), ["skills/research/SKILL.md", "skills/research/references/guide.md"]);
    assert.equal(methods[0].excluded.length, 2);
    const { format: _format, files: _files, ...metadata } = sample();
    const share = await market.prepareShare({ botId: bot.id, metadata: { ...metadata, kind: "ability" }, paths: methods[0].files.map((file) => file.path) });
    assert.equal(share.package.kind, "ability");
    assert.ok(share.package.files.every((file) => file.path.startsWith("skills/research/")));
    await assert.rejects(market.prepareShare({
      botId: bot.id, metadata: { ...metadata, kind: "ability" }, paths: ["skills/research/references/link.md"],
    }), /shareable files/);
  } finally { f.store.close(); }
});

function catalogFixture() {
  const store = new WorkbenchStore(":memory:");
  const reads: { repository: string; ref?: string; path?: string }[] = [];
  let mismatch = false;
  let index: unknown = {
    format: "livingbot-market-v1", name: "Example catalog", packages: [{
      id: sample().id, name: sample().name, description: sample().description, kind: "bot",
      repository: "example/methods", commit, path: "livingbot.json", tags: ["research"],
    }],
  };
  const market = new Marketplace(store, { read: async (input) => {
    reads.push(input);
    return {
      source: { repository: input.repository, path: input.path ?? "livingbot.json", commit: mismatch ? "d".repeat(40) : commit, blob: "c".repeat(40) },
      bytes: Buffer.from(JSON.stringify(input.path === "livingbot-market.json" ? index : sample())),
    };
  } });
  return { store, reads, market, mismatch: () => { mismatch = true; }, index: (value: unknown) => { index = value; } };
}

test("catalog discovery retains a reviewed index and resolves entries through exact package revisions", async () => {
  const f = catalogFixture();
  try {
    const catalog = await f.market.readCatalog({ repository: "example/catalog" });
    assert.equal(catalog.entries.length, 1);
    assert.equal(f.market.catalogs()[0].id, catalog.id);
    const preview = await f.market.previewCatalogEntry(catalog.id, sample().id);
    assert.deepEqual(f.reads[1], { repository: "example/methods", ref: commit, path: "livingbot.json" });
    assert.equal(preview.digest.length, 64);
    assert.deepEqual(f.market.catalog(catalog.id), catalog);
    assert.equal(f.store.list("bots").length, 0);
    f.mismatch();
    await assert.rejects(f.market.previewCatalogEntry(catalog.id, sample().id), /differs/);
    assert.equal(f.store.list("bots").length, 0);
  } finally { f.store.close(); }
});

test("catalogs reject mutable revisions and malformed entries before selecting any package", async () => {
  const f = catalogFixture();
  try {
    const index = { format: "livingbot-market-v1", name: "Example", packages: [{
      id: sample().id, kind: "bot", name: "Example", description: "Example package",
      repository: "example/methods", commit, path: "livingbot.json", tags: [],
    }] };
    for (const entry of [
      { ...index.packages[0], commit: "main" },
      { ...index.packages[0], repository: "https://example.invalid/private" },
      { ...index.packages[0], path: "../livingbot.json" },
      { ...index.packages[0], token: "Do not include credentials" },
    ]) {
      f.index({ ...index, packages: [entry] });
      await assert.rejects(f.market.readCatalog({ repository: "example/catalog" }));
    }
    assert.ok(f.reads.every((input) => input.repository === "example/catalog"));
    assert.deepEqual(f.market.catalogs(), []);
  } finally { f.store.close(); }
});

test("author submission prepares only a reviewed hosted package and never claims publication or sends a write", async () => {
  const f = catalogFixture();
  try {
    const catalog = await f.market.readCatalog({ repository: "example/catalog" });
    const preview = await f.market.previewCatalogEntry(catalog.id, sample().id);
    const reads = f.reads.length;
    assert.throws(() => f.market.prepareSubmission({ catalogId: catalog.id, previewId: preview.id, digest: "wrong" }), /exact/);
    const submission = f.market.prepareSubmission({ catalogId: catalog.id, previewId: preview.id, digest: preview.digest });
    assert.equal(submission.state, "prepared");
    assert.equal(submission.entry.commit, preview.source.commit);
    assert.equal(submission.entry.repository, "example/methods");
    const url = new URL(submission.issueUrl);
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.pathname, "/example/catalog/issues/new");
    assert.ok(url.searchParams.get("body")!.includes(`/blob/${commit}/livingbot.json`));
    assert.ok(!url.searchParams.get("body")!.includes(sample().files[0].text));
    assert.equal(f.reads.length, reads);
    assert.equal(f.store.list("bots").length, 0);
  } finally { f.store.close(); }
});

test("author submissions stay reviewable after the session and carry only reviewed tags", async () => {
  const f = catalogFixture();
  try {
    const catalog = await f.market.readCatalog({ repository: "example/catalog" });
    const preview = await f.market.previewCatalogEntry(catalog.id, sample().id);
    const submission = f.market.prepareSubmission({
      catalogId: catalog.id, previewId: preview.id, digest: preview.digest, tags: [" research ", "notes"],
    });
    assert.deepEqual(submission.entry.tags, ["research", "notes"]);
    assert.deepEqual(f.market.submissions().map((item) => item.id), [submission.id]);
    assert.deepEqual(f.market.submission(submission.id), submission);
    assert.equal(f.market.submissions()[0].state, "prepared", "Preparation is never reported as publication");
    for (const tags of [["same", "same"], Array.from({ length: 11 }, (_, index) => `t${index}`), ["x".repeat(31)], "research"]) {
      assert.throws(() => f.market.prepareSubmission({
        catalogId: catalog.id, previewId: preview.id, digest: preview.digest, tags,
      }), /标签/u);
    }
    assert.throws(() => f.market.submission("missing"), /找不到/u);
    assert.deepEqual(f.market.prepareSubmission({
      catalogId: catalog.id, previewId: preview.id, digest: preview.digest,
    }).entry.tags, []);
    assert.equal(f.store.list("bots").length, 0);
  } finally { f.store.close(); }
});

test("upload preparation binds a reviewed share and validates its GitHub destination without network writes", async () => {
  const f = await installerFixture();
  try {
    const market = new Marketplace(f.store, f.repository, f.installer);
    const bot = f.store.createBot({ name: "Example", agentId: "example" });
    assert.deepEqual(await market.shareableMethods(bot.id), []);
    await assert.rejects(readdir(`${f.root}/workspaces/${bot.agentId}`), { code: "ENOENT" });
    const { format: _format, files: _files, ...metadata } = sample();
    const share = await market.prepareShare({ botId: bot.id, metadata, paths: [], identity: "Explicit public identity" });
    const target = market.prepareUpload({ id: share.id, digest: share.digest, repository: "example/public-bots", ref: "main" });
    assert.equal(target.url, "https://github.com/example/public-bots/upload/main");
    assert.equal(target.filename, "example-researcher-1.0.0.livingbot.json");
    assert.throws(() => market.prepareUpload({ id: share.id, digest: "wrong", repository: "example/public-bots", ref: "main" }), /exact/);
    for (const repository of ["example/..", "example/.", "https://example.invalid/upload"]) {
      assert.throws(() => market.prepareUpload({ id: share.id, digest: share.digest, repository, ref: "main" }), /repository/);
    }
  } finally { f.store.close(); }
});
