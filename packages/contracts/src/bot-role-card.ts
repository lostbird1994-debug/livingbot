import * as z from "zod";

export const BOT_ROLE_TEXT_MAX_LENGTH = 20_000;
export const BotRoleCardSchema = z.object({
  identity: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  personality: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  userIdentity: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  /** Retained only so existing saved material survives migration. Not an editable module. */
  backstory: z.string().max(BOT_ROLE_TEXT_MAX_LENGTH).default(""),
  userIdentityEnabled: z.boolean().default(false),
  backstoryEnabled: z.boolean().default(false),
});
export type BotRoleCard = z.infer<typeof BotRoleCardSchema>;

/** Legacy fields remain readable until their contents have been migrated to native memory. */
export function botRoleCard(value: unknown): BotRoleCard {
  return BotRoleCardSchema.parse(value ?? {});
}

export function excludesSharedProfile(_value: unknown): boolean {
  return false;
}
