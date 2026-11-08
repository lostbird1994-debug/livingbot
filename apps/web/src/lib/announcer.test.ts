import { describe, expect, it } from "vitest";
import { announcementLine } from "./announcer";

describe("announcementLine", () => {
  it("reads the whole first paragraph, including multiple sentences", () => {
    expect(announcementLine("小雨", "**会议**改到三点了。记得带电脑。")).toBe(
      "收到小雨发来的消息：会议改到三点了。记得带电脑。",
    );
  });

  it("reads a message that has no full stop to the end", () => {
    expect(announcementLine("小雨", "部署已经完成")).toBe("收到小雨发来的消息：部署已经完成");
  });

  it("splits a latin sentence the same way", () => {
    expect(announcementLine("Rakazo", "The build passed. Two tests are flaky.")).toBe(
      "收到Rakazo发来的消息：The build passed. Two tests are flaky.",
    );
  });

  it("keeps a long clause from taking over the room", () => {
    const line = announcementLine("小雨", "一".repeat(200));
    expect(line.length).toBeLessThanOrEqual("收到小雨发来的消息：".length + 90);
    expect(line.endsWith("…")).toBe(true);
  });

  it("does not read tables, code or details after the first paragraph", () => {
    expect(
      announcementLine(
        "小雨",
        "> 检查完成，无需修改。\n\n|文件|版本|\n|---|---|\n|秘密|2|\n\n详细说明。",
      ),
    ).toBe("收到小雨发来的消息：检查完成，无需修改。");
    expect(announcementLine("小雨", "```\n代码\n```\n\n详细说明。")).toBe("");
  });

  it("says nothing about a message with nothing in it", () => {
    expect(announcementLine("小雨", "   ")).toBe("");
    expect(announcementLine("小雨", "```\ncode only\n```")).not.toContain("code only");
  });
});
