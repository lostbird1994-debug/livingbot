import { describe, expect, it } from "vitest";
import { initialBotMemory, isEmptyBotMemory, isMemoryReviewPath } from "./bot-memory.js";

describe("reserved memory review paths", () => {
  it.each([
    "memory/reviews/a.md",
    "./MEMORY/REVIEWS/a.md",
    "/memory/reviews/a.md",
    "ｍｅｍｏｒｙ/reviews/a.md",
  ])("recognizes a review path: %s", (path) => expect(isMemoryReviewPath(path)).toBe(true));
  it.each(["MEMORY.md", "memory/reviews-topic.md", "archive/memory/reviews/a.md"])(
    "preserves ordinary memory: %s",
    (path) => expect(isMemoryReviewPath(path)).toBe(false),
  );
});

describe("empty bot memory", () => {
  it.each(["", " \n\t", initialBotMemory("Fixture"), initialBotMemory("Original name")])(
    "hides an empty or untouched index: %j",
    (content) => {
      expect(isEmptyBotMemory({ path: "MEMORY.md", content })).toBe(true);
    },
  );
  it.each([
    { path: "MEMORY.md", content: `${initialBotMemory("Fixture")}A remembered fact.\n` },
    { path: "MEMORY.md", content: "# A deliberate heading" },
    { path: "notes.md", content: initialBotMemory("Fixture") },
  ])("preserves authored content: %j", (doc) => {
    expect(isEmptyBotMemory(doc)).toBe(false);
  });
});
