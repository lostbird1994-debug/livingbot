import { describe, expect, it } from "vitest";
import { botRoleCard, excludesSharedProfile } from "./bot-role-card.js";
import { UpdateBotInput } from "./domain.js";

describe("bot role card", () => {
  it("leaves legacy bots and disabled drafts on normal shared loading", () => {
    expect(excludesSharedProfile(undefined)).toBe(false);
    expect(
      excludesSharedProfile({ userIdentity: "Draft persona", backstory: "Draft setting" }),
    ).toBe(false);
  });
  it.each(["userIdentityEnabled", "backstoryEnabled"])(
    "ignores the retired %s switch for shared loading",
    (flag) => {
      expect(excludesSharedProfile({ [flag]: true })).toBe(false);
    },
  );
  it("requires the saved baseline for updates, including empty text and switches", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot", roleCard: {} }).success).toBe(false);
    expect(
      UpdateBotInput.safeParse({
        botId: "bot",
        roleCard: {},
        expectedRoleCard: botRoleCard(undefined),
      }).success,
    ).toBe(true);
  });
});
