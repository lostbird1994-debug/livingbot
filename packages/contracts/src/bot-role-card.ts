import * as z from "zod";

export const BOT_ROLE_TEXT_MAX_LENGTH = 20_000;
export const BotRoleCardSchema = z.object({
  identity: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  personality: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  userIdentity: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  backstory: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  userIdentityEnabled: z.boolean().default(false),
  backstoryEnabled: z.boolean().default(false),
});
export type BotRoleCard = z.infer<typeof BotRoleCardSchema>;

/** Legacy bots have no role card. Switches, rather than text presence, control loading. */
export function botRoleCard(value: unknown): BotRoleCard {
  return BotRoleCardSchema.parse(value ?? {});
}

export function excludesSharedProfile(value: unknown): boolean {
  const card = botRoleCard(value);
  return card.userIdentityEnabled || card.backstoryEnabled;
}
