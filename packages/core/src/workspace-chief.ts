/** The workspace's onboarding bot keeps its role even after the user renames it. */
export const WORKSPACE_CHIEF_NAME = "Chief";
export const WORKSPACE_CHIEF_SPAWN_KEY = "onboarding:first";

export function findWorkspaceChief<T extends { name: string; spawnKey: string | null }>(
  bots: readonly T[],
): T | undefined {
  const identified = bots.find((bot) => bot.spawnKey === WORKSPACE_CHIEF_SPAWN_KEY);
  if (identified) return identified;
  // Older onboarding bots did not carry the marker. Never guess between namesakes.
  const legacy = bots.filter((bot) => bot.name === WORKSPACE_CHIEF_NAME);
  return legacy.length === 1 ? legacy[0] : undefined;
}
