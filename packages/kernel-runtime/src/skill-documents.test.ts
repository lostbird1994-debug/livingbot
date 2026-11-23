import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { GatewayRequests } from "./contracts.ts";
import { SkillDocuments } from "./skill-documents.ts";

test("skill documents preserve scope, expose support files and reject escape paths", async () => {
  const root = await mkdtemp(resolve("local/test-fixtures/skill-documents-"));
  try {
    await mkdir(join(root, "private"), { recursive: true });
    await mkdir(join(root, "shared"));
    await writeFile(join(root, "private/SKILL.md"), "# Private procedure");
    await writeFile(join(root, "shared/SKILL.md"), "# Shared procedure");
    await writeFile(join(root, "outside.txt"), "private value");
    await symlink(join(root, "outside.txt"), join(root, "private/link.md"));
    const gateway = {
      request: async (method: string) =>
        method === "skills.status"
          ? {
              skills: [
                { name: "private", source: "openclaw-workspace", baseDir: join(root, "private") },
                { name: "shared", source: "openclaw-extra", baseDir: join(root, "shared") },
              ],
            }
          : { changes: [] },
    } as GatewayRequests;
    const library = new SkillDocuments(gateway);
    assert.deepEqual(
      (await library.list("agent")).map((x) => x.name),
      ["private"],
    );
    assert.equal(
      (await library.read("agent", "openclaw-workspace:private")).content,
      "# Private procedure",
    );
    assert.equal(
      (await library.read("agent", "openclaw-extra:shared", "SKILL.md", true)).content,
      "# Shared procedure",
    );
    await assert.rejects(library.read("agent", "openclaw-workspace:private", "SKILL.md", true));
    await assert.rejects(library.read("agent", "openclaw-extra:shared"));
    await assert.rejects(library.read("agent", "openclaw-workspace:private", "../outside.txt"));
    await assert.rejects(library.read("agent", "openclaw-workspace:private", "link.md"));
  } finally {
    const trash = await mkdtemp(join(homedir(), ".Trash/LivingBot-skill-documents-test-"));
    await rename(root, join(trash, "fixture"));
    console.log(JSON.stringify({ original: root, recovery: join(trash, "fixture") }));
  }
});
