import type { Routine } from "@livingbot/contracts";
import type { CronLabels } from "@livingbot/core";
import { formatCron, isOneShotRoutineCron, localizedClock } from "@livingbot/core";

/** Cadence buckets the task list groups by, most frequent first. */
export const ROUTINE_SCHEDULE_GROUPS = ["daily", "weekly", "monthly", "other"] as const;
export type RoutineScheduleGroup = (typeof ROUTINE_SCHEDULE_GROUPS)[number];

export type RoutineScheduleRow = {
  routine: Routine;
  /**
   * The schedule without the cadence the heading already names ("18:32", "5 日 10:30"),
   * or empty when the routine only reacts to a trigger.
   */
  detail: string;
};

export type RoutineScheduleSection = {
  group: RoutineScheduleGroup;
  rows: RoutineScheduleRow[];
};

type Cadence = {
  group: RoutineScheduleGroup;
  /** Coarse sort key inside the group: day of month, or weekday. */
  slot: number;
  /** Seconds from midnight, so the group reads in clock order. */
  at: number;
  detail: string;
};

// Monday first, so a weekly group sorts the way the week reads.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function clockFields(cron: string): { clock: string; at: number; day: string; dow: string } | null {
  const trimmed = cron.trim();
  if (isOneShotRoutineCron(trimmed)) return null;
  const [minuteField = "", hourField = "", day = "", month = "", dow = "", ...rest] =
    trimmed.split(/\s+/);
  // Only wall-clock schedules can be read as a time of day; steps stay in `other`.
  if (rest.length > 0 || month !== "*") return null;
  if (!/^\d+$/.test(minuteField) || !/^\d+$/.test(hourField)) return null;
  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (minute > 59 || hour > 23) return null;
  return {
    clock: `${hour}:${String(minute).padStart(2, "0")}`,
    at: hour * 3600 + minute * 60,
    day,
    dow,
  };
}

/** The day set a weekly field names (0 = Sunday), or null when it is a step or a name. */
function weekdaysOf(field: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from > to || to > 7) return null;
    for (let day = from; day <= to; day += 1) days.add(day % 7);
  }
  return days.size > 0 ? days : null;
}

function cadenceOf(cron: string, labels: CronLabels, locale: string): Cadence | null {
  const fields = clockFields(cron);
  if (!fields) return null;
  const { clock, at, day, dow } = fields;
  // Localized here rather than inside the label callbacks, so the labels only
  // choose the words and both shapes read the clock the app's locale writes.
  const localClock = localizedClock(clock, locale);
  if (dow === "*") {
    if (day === "*") {
      return { group: "daily", slot: 0, at, detail: localClock };
    }
    if (/^\d+$/.test(day) && Number(day) >= 1 && Number(day) <= 31) {
      return {
        group: "monthly",
        slot: Number(day),
        at,
        detail: labels.onDayAt(Number(day), localClock),
      };
    }
    return null;
  }
  if (day !== "*") return null;
  const days = weekdaysOf(dow);
  if (!days) return null;
  const slot = WEEK_ORDER.findIndex((weekday) => days.has(weekday));
  const only = days.size === 1 ? WEEK_ORDER[slot] : undefined;
  return {
    group: "weekly",
    slot,
    at,
    detail:
      only === undefined
        ? formatCron(cron, labels)
        : `${labels.weekdayNames[only] ?? ""} ${localClock}`,
  };
}

/**
 * Routines grouped by how often they run, each group in the order it reads:
 * daily by clock time, monthly by day of the month, weekly by weekday. A routine
 * with several schedules groups by its first one; anything without a fixed
 * wall-clock schedule keeps its place in `other`.
 */
export function groupRoutinesBySchedule(
  routines: Routine[],
  labels: CronLabels,
  locale: string,
): RoutineScheduleSection[] {
  const buckets = new Map<
    RoutineScheduleGroup,
    (RoutineScheduleRow & Required<Pick<Cadence, "slot" | "at">> & { index: number })[]
  >();
  routines.forEach((routine, index) => {
    const cron = routine.crons[0];
    const cadence = cron ? cadenceOf(cron, labels, locale) : null;
    const group = cadence?.group ?? "other";
    const row = {
      routine,
      detail: cadence?.detail ?? (cron ? formatCron(cron, labels) : ""),
      slot: cadence?.slot ?? 0,
      at: cadence?.at ?? 0,
      index,
    };
    const rows = buckets.get(group);
    if (rows) rows.push(row);
    else buckets.set(group, [row]);
  });
  return ROUTINE_SCHEDULE_GROUPS.flatMap((group) => {
    const rows = buckets.get(group);
    if (!rows?.length) return [];
    rows.sort((a, b) => a.slot - b.slot || a.at - b.at || a.index - b.index);
    return [
      {
        group,
        rows: rows.map(({ routine, detail }) => ({ routine, detail })),
      },
    ];
  });
}
