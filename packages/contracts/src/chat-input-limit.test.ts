import { describe, expect, it } from "vitest";
import { THREAD_MESSAGE_TEXT_MAX_LENGTH } from "./domain.js";
import { appContract } from "./rpc.js";

describe("direct chat payload limit", () => {
  const schema = appContract.threads.send["~orpc"].inputSchema!;
  it("accepts ordinary long text but rejects an oversized paste before storage", () => {
    expect(
      schema.safeParse({ botId: "bot", text: "x".repeat(THREAD_MESSAGE_TEXT_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ botId: "bot", text: "x".repeat(THREAD_MESSAGE_TEXT_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});
