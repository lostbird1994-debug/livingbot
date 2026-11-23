import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { adminPath, SuperAdministrator } from "./admin.ts";
import type { KernelControl } from "./service.ts";
import { WorkbenchService } from "./service.ts";
import { WorkbenchStore } from "./store.ts";
import { SUPER_ADMIN_AGENT_ID } from "./system-policy.ts";
import { Workspaces } from "./workspaces.ts";

test("administrator authority is host-bound, edits are versioned and deletion is recoverable", async () => {
  await mkdir("local/test-fixtures", { recursive: true });
  const root = await mkdtemp(resolve("local/test-fixtures/admin-policy-"));
  const trash = await mkdtemp(join(homedir(), ".Trash/LivingBot-admin-test-"));
  const store = new WorkbenchStore(":memory:");
  const kernel = Object.assign(new EventEmitter(), {
    generation: 1,
    phase: "ready",
    request: async () => [],
    send: async () => ({ runId: "unused", status: "started" }),
    recoverHistory: async () => ({ messages: [] }),
    abort: async () => ({ aborted: true }),
  }) as unknown as KernelControl;
  const service = new WorkbenchService(store, kernel);
  const workspaces = new Workspaces(join(root, "workspaces"));
  const admin = store.createBot({ name: "Administrator", agentId: SUPER_ADMIN_AGENT_ID });
  const other = store.createBot({ name: "Other", agentId: "other" });
  const base = await workspaces.initialize(other.agentId);
  await writeFile(join(base, "memory/example.md"), "original");
  const authority = (bot: typeof admin, id: string) => {
    const chat = store.privateConversation(bot.id);
    const task = store.beginSubmission({
      submissionId: id,
      botId: bot.id,
      conversationId: chat.id,
      message: "inspect",
    }).task;
    const run = {
      id: `run-${id}`,
      taskId: task.id,
      generation: 1,
      state: "running",
      sessionKey: store.engineSessionKey(chat.id, bot.id),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.put("runs", run);
    store.put("tasks", { ...task, status: "running" });
    return {
      agentId: bot.agentId,
      runId: run.id,
      sessionKey: store.engineSessionKey(chat.id, bot.id),
    };
  };
  const authorized = authority(admin, "admin-run");
  const denied = authority(other, "other-run");
  const tool = new SuperAdministrator(service, workspaces, join(root, "revisions"), trash);
  const invoke = (input: Record<string, unknown>) =>
    tool.invoke({ ...authorized, botId: other.id, ...input });
  try {
    await assert.rejects(tool.invoke({ ...denied, operation: "list_bots" }), /只有超级管理员/);
    await assert.rejects(
      tool.invoke({ ...authorized, runId: "invented", operation: "list_bots" }),
      /No active/,
    );
    await assert.rejects(adminPath(base, "../outside"), /越过/);
    await symlink(join(root, "outside"), join(base, "memory/link"));
    await assert.rejects(adminPath(base, "memory/link"), /符号链接/);
    const parentTaskId = store.get<any>("runs", authorized.runId).taskId;
    const originalTask = store.get<any>("tasks", parentTaskId);
    store.put("tasks", { ...originalTask, routine: { id: "capability-audit:synthetic" } });
    await assert.rejects(
      invoke({ operation: "trash_file", path: "memory/example.md", expectedDigest: null }),
      /审计只能/,
    );
    await assert.rejects(
      invoke({ operation: "delegate", message: "change files", toolCallId: "audit-denied" }),
      /审计只能/,
    );
    await assert.rejects(
      tool.invoke({
        ...authorized,
        botId: admin.id,
        operation: "write_file",
        path: "tasks/capability-audit/../../memory.md",
        content: "bad",
        expectedDigest: null,
      }),
      /审计只能/,
    );
    store.put("tasks", originalTask);
    store.updateBot(other.id, { archivedAt: Date.now() });
    await assert.rejects(
      invoke({ operation: "delegate", message: "wake", toolCallId: "archived-denied" }),
      /恢复归档/,
    );
    const archivedRead = (await invoke({
      operation: "read_file",
      path: "memory/example.md",
    })) as any;
    assert.equal(archivedRead.content, "original");
    store.updateBot(other.id, { archivedAt: undefined });
    const first = (await invoke({ operation: "read_file", path: "memory/example.md" })) as any;
    await assert.rejects(
      invoke({
        operation: "write_file",
        path: "memory/example.md",
        expectedDigest: "wrong",
        content: "bad",
      }),
      /已变化/,
    );
    const changed = (await invoke({
      operation: "write_file",
      path: "memory/example.md",
      expectedDigest: first.digest,
      content: "changed",
    })) as any;
    assert.equal(await readFile(changed.recovery, "utf8"), "original");
    assert.equal(await readFile(join(base, "memory/example.md"), "utf8"), "changed");
    const removed = (await invoke({
      operation: "trash_file",
      path: "memory/example.md",
      expectedDigest: changed.digest,
    })) as any;
    assert.equal(await readFile(removed.recovery, "utf8"), "changed");
    await assert.rejects(readFile(join(base, "memory/example.md")), { code: "ENOENT" });
    await writeFile(join(base, "memory/binary.bin"), Buffer.from([0, 255, 1]));
    const binary = (await invoke({ operation: "file_info", path: "memory/binary.bin" })) as any;
    const binaryTrash = (await invoke({
      operation: "trash_file",
      path: "memory/binary.bin",
      expectedDigest: binary.digest,
    })) as any;
    assert.deepEqual(await readFile(binaryTrash.recovery), Buffer.from([0, 255, 1]));
    await writeFile(join(base, "memory/private.sqlite"), "database");
    await assert.rejects(
      invoke({ operation: "trash_file", path: "memory/private.sqlite", expectedDigest: null }),
      /资料库/,
    );
  } finally {
    await writeFile(
      join(trash, "recovery.json"),
      JSON.stringify({ original: root, recovery: join(trash, "fixture") }),
    );
    service.detach();
    store.close();
    await rename(root, join(trash, "fixture"));
  }
});

test("hidden administrator delegations have an explicit task title", () => {
  const store = new WorkbenchStore(":memory:");
  try {
    const bot = store.createBot({ name: "Example", agentId: "example" });
    const chat = store.privateConversation(bot.id);
    const { task } = store.beginSubmission({
      submissionId: "admin-delegation:example",
      botId: bot.id,
      conversationId: chat.id,
      message: "Delegated work",
      hiddenInput: true,
      queueMode: "followup",
    });
    assert.equal(task.title, "管理员分派");
    assert.equal(store.messages(chat.id).filter((message) => message.role === "user").length, 0);
  } finally {
    store.close();
  }
});
