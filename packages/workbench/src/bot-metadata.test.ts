import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { WorkbenchStore } from "./store.ts";
import type { Bot, BotSection } from "./contracts.ts";

function store(): WorkbenchStore {
  const base = resolveFixture();
  return new WorkbenchStore(join(base, "workbench.sqlite"));
}
function resolveFixture(): string {
  return join(mkdtempSync(join("local/test-fixtures", "bot-metadata-")));
}

test("avatar set, pin, position and section survive a reopen", () => {
  const path = join(mkdtempSync(join("local/test-fixtures", "bot-metadata-")), "workbench.sqlite");
  const first = new WorkbenchStore(path);
  const section = first.createBotSection("财务");
  const bot = first.createBot({ name: "Crying", agentId: "crying" });
  first.updateBot(bot.id, { avatarSet: "ledger", pinned: true, sectionId: section.id });
  first.close();

  const reopened = new WorkbenchStore(path);
  const stored = reopened.get<Bot>("bots", bot.id)!;
  assert.equal(stored.avatarSet, "ledger");
  assert.equal(stored.pinned, true);
  assert.equal(stored.sectionId, section.id);
  assert.equal(reopened.list<BotSection>("botSections")[0]?.name, "财务");
  reopened.close();
});

test("an explicit order is applied and rejects unknown or repeated Bots", () => {
  const s = store();
  const a = s.createBot({ name: "A" });
  const b = s.createBot({ name: "B" });
  const c = s.createBot({ name: "C" });
  const ordered = s.reorderBots([c.id, a.id, b.id]);
  assert.deepEqual(ordered.map((bot) => bot.position), [0, 1, 2]);
  assert.throws(() => s.reorderBots([a.id, a.id]), /repeat/);
  assert.throws(() => s.reorderBots(["missing"]), /Unknown Bot/);
  s.close();
});

test("clearing a section keeps the Bot and archiving a section keeps its record", () => {
  const s = store();
  const section = s.createBotSection("情报");
  const bot = s.createBot({ name: "Scout" });
  s.updateBot(bot.id, { sectionId: section.id });
  s.updateBot(bot.id, { sectionId: null });
  assert.equal(s.get<Bot>("bots", bot.id)?.sectionId, undefined);
  s.updateBot(bot.id, { sectionId: section.id });
  s.deleteBotSection(section.id);
  assert.equal(s.get<Bot>("bots", bot.id)?.sectionId, undefined, "the Bot returns to the unsectioned list");
  const archived = s.list<BotSection>("botSections").find((entry) => entry.id === section.id);
  assert.match(archived?.name ?? "", /已移除/);
  s.close();
});

test("records written before these fields existed still read cleanly", () => {
  const s = store();
  s.put("bots", {
    id: "legacy", agentId: "legacy", name: "旧伙伴", description: "", identity: "", color: "teal", createdAt: 1,
  });
  const legacy = s.get<Bot>("bots", "legacy")!;
  assert.equal(legacy.avatarSet, undefined);
  assert.equal(legacy.pinned, undefined);
  assert.equal(legacy.position, undefined);
  s.close();
});
