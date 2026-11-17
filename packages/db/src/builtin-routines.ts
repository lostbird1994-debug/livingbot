import type { Actor } from "@livingbot/contracts";
import { RoutineUsageTriggerSchema } from "@livingbot/contracts";
import { BUILTIN_ROUTINES, nextCronDate } from "@livingbot/core";
import type { Prisma } from "./generated/prisma/client.js";

/** Keep system definitions current while preserving toggles, history and usage counters. */
export async function ensureBuiltinRoutines(
  tx: Pick<Prisma.TransactionClient, "routine" | "user">,
  actor: Actor,
  botId: string,
) {
  const user = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { timezone: true },
  });
  for (const definition of BUILTIN_ROUTINES) {
    const id = `${definition.kind === "memory-organization" ? "memory-review" : definition.kind}:${botId}`;
    const existing = await tx.routine.findFirst({
      where: { spaceId: actor.spaceId, userId: actor.userId, botId, builtinKind: definition.kind },
      select: {
        id: true,
        crons: true,
        timezone: true,
        active: true,
        prompt: true,
        name: true,
        builtinKind: true,
        usageTrigger: true,
        notify: true,
        requireOutput: true,
      },
    });
    const timezone = user?.timezone ?? "UTC";
    const crons = definition.cron ? [definition.cron] : [];
    const scheduleChanged = Boolean(
      existing &&
        definition.cron &&
        (JSON.stringify(existing.crons) !== JSON.stringify(crons) ||
          existing.timezone !== timezone),
    );
    if (
      !scheduleChanged &&
      existing &&
      existing.prompt === definition.prompt &&
      existing.name === definition.name &&
      JSON.stringify(RoutineUsageTriggerSchema.safeParse(existing.usageTrigger).data ?? null) ===
        JSON.stringify(definition.usageTrigger) &&
      !existing.notify &&
      existing.requireOutput === (definition.kind === "context-audit")
    )
      continue;
    await tx.routine.upsert({
      where: { id: existing?.id ?? id },
      create: {
        id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        builtinKind: definition.kind,
        name: definition.name,
        prompt: definition.prompt,
        crons: definition.cron ? [definition.cron] : [],
        ...(definition.usageTrigger ? { usageTrigger: definition.usageTrigger } : {}),
        timezone,
        active: definition.defaultActive,
        ...(definition.usageTrigger && definition.defaultActive ? { usageSince: new Date() } : {}),
        notify: false,
        requireOutput: definition.kind === "context-audit",
        memoryMaintenance: definition.kind === "memory-organization",
      },
      update: {
        ...(scheduleChanged
          ? {
              crons,
              timezone,
              nextRunAt:
                existing?.active && definition.cron
                  ? nextCronDate(definition.cron, new Date(), timezone)
                  : null,
            }
          : {}),
        builtinKind: definition.kind,
        name: definition.name,
        prompt: definition.prompt,
        notify: false,
        requireOutput: definition.kind === "context-audit",
        ...(definition.usageTrigger ? { usageTrigger: definition.usageTrigger } : {}),
      },
    });
  }
}
