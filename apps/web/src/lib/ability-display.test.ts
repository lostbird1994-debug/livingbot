import { describe, expect, it } from "vitest";
import type { Ability } from "../../../../packages/workbench/src/contracts";
import { abilityDisplay } from "./ability-display";

function ability(nativeName: string, patch: Partial<Ability> = {}): Ability {
  return {
    id: `skill:${nativeName}`,
    name: nativeName,
    description: "An upstream description that belongs in the detail view.",
    kind: "method",
    source: "openclaw-bundled",
    version: "native",
    permissions: [],
    botIds: [],
    state: "available",
    configuration: { native: { nativeName, nativeKind: "skill" } },
    ...patch,
  };
}

describe("abilityDisplay", () => {
  it("uses native identity rather than a translated label and preserves detail data", () => {
    const item = ability("apple-notes", { name: "Upstream label" });
    const before = structuredClone(item);
    expect(abilityDisplay(item)).toEqual({
      name: "苹果备忘录",
      description: "创建、查找、编辑和导出苹果备忘录",
      originalName: "apple-notes",
      type: "技能",
      origin: "系统内置",
    });
    expect(item).toEqual(before);
  });

  it("distinguishes skills and connections while prioritizing native tools over service kind", () => {
    expect(
      abilityDisplay(
        ability("read", {
          kind: "tool",
          source: "core",
          configuration: { native: { nativeName: "read", nativeKind: "tool" } },
        }),
      ),
    ).toMatchObject({
      name: "读取文件",
      description: "读取文件内容",
      type: "工具",
      origin: "系统内置",
    });
    expect(
      abilityDisplay(
        ability("docs__search", {
          kind: "service",
          source: "docs",
          configuration: { native: { nativeName: "docs__search", nativeKind: "tool" } },
        }),
      ),
    ).toMatchObject({ type: "工具", origin: "自行添加" });
    expect(
      abilityDisplay(
        ability("docs", {
          kind: "service",
          source: "mcp",
          configuration: { native: { nativeName: "docs", nativeKind: "service" } },
        }),
      ),
    ).toMatchObject({ type: "应用连接", origin: "自行添加" });
    expect(abilityDisplay(ability("read"))).toMatchObject({
      type: "技能",
      name: "扩展技能（read）",
    });
  });

  it.each([
    ["livingbot-ima", "腾讯 IMA 知识库"],
    ["tencent-ima", "腾讯 IMA 知识库"],
    ["livingbot-feishu", "飞书 CLI"],
    ["飞书cli", "飞书 CLI"],
    ["飞书CLI", "飞书 CLI"],
    ["livingbot-ego-browser", "Ego 浏览器"],
    ["livingbot-qq-email", "QQ 邮箱"],
    ["qq-mail", "QQ 邮箱"],
  ])("keeps added brand %s out of the built-in category", (nativeName, name) => {
    expect(abilityDisplay(ability(nativeName))).toMatchObject({ name, origin: "自行添加" });
  });

  it("recognizes bundled origins using native source while retaining explicit added overrides", () => {
    const native = { nativeName: "livingbot_conversations", nativeKind: "tool" };
    const tool = ability("livingbot_conversations", {
      kind: "tool",
      source: "livingbot",
      configuration: { native },
    });
    expect(abilityDisplay(tool)).toMatchObject({ type: "工具", origin: "系统内置" });
    expect(
      abilityDisplay({
        ...tool,
        source: "plugin",
        configuration: { native: { ...native, nativeSource: "livingbot" } },
      }),
    ).toMatchObject({ origin: "系统内置" });
    expect(
      abilityDisplay({
        ...tool,
        configuration: { native: { ...native, nativeSource: "mcp" } },
      }),
    ).toMatchObject({ origin: "自行添加" });
    expect(
      abilityDisplay(
        ability("apple-notes", {
          source: "plugin",
          configuration: {
            native: { nativeName: "apple-notes", nativeKind: "skill", bundled: true },
          },
        }),
      ),
    ).toMatchObject({ origin: "系统内置" });
    for (const nativeName of ["tencent-ima", "飞书cli", "ego-browser", "qq-mail", "custom-skill"]) {
      expect(
        abilityDisplay(
          ability(nativeName, {
            source: nativeName === "custom-skill" ? "migrated" : "livingbot",
            configuration: {
              native: { nativeName, nativeKind: "skill", nativeSource: "livingbot", bundled: true },
            },
          }),
        ),
      ).toMatchObject({ origin: "自行添加" });
    }
  });

  it.each(["migrated", "private", "openclaw-workspace", "openclaw-managed"])(
    "preserves existing Chinese copy for %s skills, even with a familiar native name",
    (source) => {
      expect(
        abilityDisplay(
          ability("summarize", {
            source,
            name: "我的阅读助手",
            description: "整理我选定的资料",
          }),
        ),
      ).toMatchObject({
        name: "我的阅读助手",
        description: "整理我选定的资料",
        origin: "自行添加",
      });
    },
  );

  it("uses truthful fallbacks for unknown names and never forwards long English prose", () => {
    expect(
      abilityDisplay(
        ability("new-extension", {
          source: "private",
          description: "Detailed instructions. ".repeat(100),
        }),
      ),
    ).toEqual({
      name: "扩展技能（new-extension）",
      description: "查看详情以了解这项扩展能力",
      originalName: "new-extension",
      type: "技能",
      origin: "自行添加",
    });
    expect(
      abilityDisplay(
        ability("unknown", {
          name: "自定义助手",
          configuration: { native: null },
        }),
      ),
    ).toMatchObject({ name: "自定义助手", originalName: "自定义助手" });
    expect(abilityDisplay(ability("toString"))).toMatchObject({ name: "扩展技能（toString）" });
  });
});
