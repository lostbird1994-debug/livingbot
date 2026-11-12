import { describe, expect, it } from "vitest";
import { matchWake, normalizeWithMap, withinOneEdit } from "./wake-word";

const bots = [
  { id: "bot-1", name: "小雨" },
  { id: "bot-2", name: "LivingBot" },
  { id: "bot-3", name: "阿尔法" },
];

describe("matchWake", () => {
  it("takes the words after the name as the first turn", () => {
    const hit = matchWake("小雨 帮我看下今天的邮件", bots);
    expect(hit?.bot.id).toBe("bot-1");
    expect(hit?.rest).toBe("帮我看下今天的邮件");
  });

  it("ignores the filler before a name and the punctuation after it", () => {
    const hit = matchWake("嘿 LivingBot，今天天气怎么样", bots);
    expect(hit?.bot.id).toBe("bot-2");
    expect(hit?.rest).toBe("今天天气怎么样");
  });

  it("leaves an empty turn when only the name was said", () => {
    expect(matchWake("小雨", bots)?.rest).toBe("");
    expect(matchWake("喂，小雨。", bots)?.rest).toBe("");
  });

  it("accepts one wrong character in a longer name", () => {
    const hit = matchWake("阿尔发 今天开会吗", bots);
    expect(hit?.bot.id).toBe("bot-3");
    expect(hit?.rest).toBe("今天开会吗");
  });

  it("never wakes on a short name buried in a sentence", () => {
    expect(matchWake("今天下小雨了", bots)).toBeNull();
  });

  it("forgives one wrong character in a short name, but only when it opens the phrase", () => {
    const hit = matchWake("晓雨，今天有什么安排", bots);
    expect(hit?.bot.id).toBe("bot-1");
    expect(hit?.rest).toBe("今天有什么安排");
    // The same near miss in the middle of a sentence stays silent.
    expect(matchWake("今天晓雨不在", bots)).toBeNull();
  });

  it("never wakes on a name nobody said", () => {
    expect(matchWake("帮我把这个文件发出去", bots)).toBeNull();
  });

  it("picks the name that was spoken first", () => {
    const hit = matchWake("小雨让 LivingBot 说句话", bots);
    expect(hit?.bot.id).toBe("bot-1");
  });

  it("matches a latin name whatever case the recogniser used", () => {
    expect(matchWake("RAKAZO 在吗", bots)?.bot.id).toBe("bot-2");
  });

  it("needs names long enough to mean something", () => {
    expect(matchWake("阿 在吗", [{ id: "one", name: "阿" }])).toBeNull();
  });

  it("uses a short name and explicit aliases without the role suffix", () => {
    const team = [{ id: "finance", name: "Crying | 财务经理", aliases: ["小哭"] }];
    expect(matchWake("Crying，核对账目", team)).toMatchObject({
      bot: { id: "finance" },
      rest: "核对账目",
    });
    expect(matchWake("嗨，小哭", team)?.bot.id).toBe("finance");
  });

  it("does not pick a bot by array order when aliases collide", () => {
    const team = [
      { id: "a", name: "甲甲", aliases: ["小哭"] },
      { id: "b", name: "乙乙", aliases: ["小哭"] },
    ];
    expect(matchWake("小哭，帮我", team)).toBeNull();
    expect(matchWake("甲甲，帮我", team)?.bot.id).toBe("a");
  });

  it("does not treat a name in an instruction as a switch", () => {
    expect(matchWake("请把邮件转发给 LivingBot", bots)).toBeNull();
  });

  it("keeps an English name that begins with a greeting syllable intact", () => {
    expect(matchWake("Hilda, help me", [{ id: "a", name: "Hilda" }])?.rest).toBe("help me");
  });
});

describe("normalizeWithMap", () => {
  it("maps every kept character back to where it was", () => {
    const { text, map } = normalizeWithMap("嘿，RaKa Zo！在吗");
    expect(text).toBe("嘿rakazo在吗");
    expect(map).toHaveLength(text.length);
    expect("嘿，RaKa Zo！在吗"[map[4] as number]).toBe("a");
  });
});

describe("withinOneEdit", () => {
  it("counts one substitution, insertion or deletion", () => {
    expect(withinOneEdit("rakazo", "rakaza")).toBe(true);
    expect(withinOneEdit("rakazo", "rakazo")).toBe(true);
    expect(withinOneEdit("rakazo", "raakazo")).toBe(true);
    expect(withinOneEdit("rakazo", "rkazo")).toBe(true);
    expect(withinOneEdit("rakazo", "rakozo")).toBe(true);
  });

  it("rejects two changes at once", () => {
    expect(withinOneEdit("rakazo", "rektzo")).toBe(false);
    expect(withinOneEdit("rakazo", "ra")).toBe(false);
  });
});
