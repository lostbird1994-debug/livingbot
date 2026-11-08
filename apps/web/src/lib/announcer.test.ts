import { describe, expect, it, vi } from "vitest";
import { Announcer, announcementLine } from "./announcer";
import { speaker } from "./tts";

it("discards an announcement already waiting for its chime when a voice session starts", async () => {
  const speak = vi.spyOn(speaker, "speak").mockResolvedValue(undefined);
  const speaking = vi.spyOn(speaker, "isSpeaking").mockReturnValue(false);
  const announcer = new Announcer();
  try {
    announcer.announce("有新消息");
    announcer.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(speak).not.toHaveBeenCalled();
  } finally {
    speak.mockRestore();
    speaking.mockRestore();
  }
});

describe("announcementLine", () => {
  it("reads the whole first paragraph, including multiple sentences", () => {
    expect(announcementLine("小雨", "**会议**改到三点了。记得带电脑。")).toBe(
      "收到小雨发来的消息：会议改到三点了。记得带电脑。",
    );
  });

  it("reads a message that has no full stop to the end", () => {
    expect(announcementLine("小雨", "部署已经完成")).toBe("收到小雨发来的消息：部署已经完成");
  });

  it("accepts a short generated notification", () => {
    expect(announcementLine("Rakazo", "Build passed.")).toBe("收到Rakazo发来的消息：Build passed.");
  });

  it("keeps a long clause from taking over the room", () => {
    const line = announcementLine("小雨", "一".repeat(200));
    expect(line).toBe("收到小雨发来的消息：有新消息，请查看");
  });

  it("never falls back to reading a full reply", () => {
    expect(
      announcementLine(
        "小雨",
        "> 检查完成，无需修改。\n\n|文件|版本|\n|---|---|\n|秘密|2|\n\n详细说明。",
      ),
    ).toBe("收到小雨发来的消息：有新消息，请查看");
  });

  it("says nothing about a message with nothing in it", () => {
    expect(announcementLine("小雨", "   ")).toBe("");
    expect(announcementLine("小雨", "   ")).not.toContain("code only");
  });
});
