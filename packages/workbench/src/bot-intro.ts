/**
 * Adapted from 1.0 apps/api/src/routes/bots.ts botIntroPrompt/enqueueBotIntroRun.
 * The native kernel owns the turn; there is no second onboarding chat engine.
 */
export function botIntroPrompt(spaceName: string): string {
  return [
    "You were just created.",
    spaceName ? `Their team space is called ${JSON.stringify(spaceName)}.` : "",
    "Greet them in a few words and ask in one sentence what they want you for, suggesting two to four short options that fit your name, anything your description or instructions already say, and what you know about them, never a stock list. They can also type their own answer.",
    "If your profile already makes that clear, say in one line what you will do instead of asking.",
    "Then get started, asking one follow-up only if you cannot start without it.",
    "This is an internal creation event, not a message from the user. Use the user's language (Chinese by default). Do not run unrelated tasks or send external messages.",
  ].filter(Boolean).join("\n");
}
