import type { Routine } from "@livingbot/contracts";
import { ENGLISH_CRON_LABELS } from "@livingbot/core";
import { describe, expect, it } from "vitest";
import { groupRoutinesBySchedule } from "./routine-schedule";

const labels = ENGLISH_CRON_LABELS;

function routine(name: string, crons: string[], overrides: Partial<Routine> = {}): Routine {
  return {
    id: name,
    botId: "bot-1",
    name,
    prompt: "",
    crons,
    timezone: "Asia/Shanghai",
    active: true,
    notify: true,
    requireOutput: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The list as it reads on screen: group, then `name @ detail`. */
function outline(routines: Routine[], locale = "en") {
  return groupRoutinesBySchedule(routines, labels, locale).map((section) => [
    section.group,
    section.rows.map((row) => `${row.routine.name} @ ${row.detail}`),
  ]);
}

describe("groupRoutinesBySchedule", () => {
  it("splits daily from monthly and orders each by clock time", () => {
    // The order the API returns them in is the order the old list showed.
    const routines = [
      routine("assets", ["30 10 5 * *"]),
      routine("expenses", ["0 15 4 * *"]),
      routine("revenue", ["0 12 3 * *"]),
      routine("other-pnl", ["30 11 5 * *"]),
      routine("daily-review", ["32 18 * * *"]),
      routine("receivables", ["0 13 5 * *"]),
      routine("daily-tidy", ["2 19 * * *"]),
      routine("project-pnl", ["0 14 5 * *"]),
      routine("memory", ["0 18 * * *"]),
    ];
    expect(outline(routines)).toEqual([
      ["daily", ["memory @ 6:00 PM", "daily-review @ 6:32 PM", "daily-tidy @ 7:02 PM"]],
      [
        "monthly",
        [
          "revenue @ on the 3rd at 12:00 PM",
          "expenses @ on the 4th at 3:00 PM",
          "assets @ on the 5th at 10:30 AM",
          "other-pnl @ on the 5th at 11:30 AM",
          "receivables @ on the 5th at 1:00 PM",
          "project-pnl @ on the 5th at 2:00 PM",
        ],
      ],
    ]);
  });

  it("reads a weekly schedule by weekday, Monday first", () => {
    const routines = [
      routine("mon", ["0 9 * * 1"]),
      routine("sun", ["0 8 * * 0"]),
      routine("weekdays", ["0 7 * * 1-5"]),
    ];
    expect(outline(routines)).toEqual([
      [
        "weekly",
        ["weekdays @ Weekdays at 7:00 AM", "mon @ Monday 9:00 AM", "sun @ Sunday 8:00 AM"],
      ],
    ]);
  });

  it("keeps schedules without a wall-clock time in one group, in list order", () => {
    const routines = [
      routine("interval", ["*/5 * * * *"]),
      routine("once", ["@once"]),
      routine("webhook", [], { webhookEnabled: true }),
      routine("hourly", ["0 * * * *"]),
    ];
    expect(outline(routines)).toEqual([
      [
        "other",
        ["interval @ Every 5 minutes", "once @ One-time", "webhook @ ", "hourly @ Every hour"],
      ],
    ]);
  });

  it("drops a group nobody is in and keeps paused routines in place", () => {
    const routines = [
      routine("paused-daily", ["0 18 * * *"], { active: false }),
      routine("daily", ["0 9 * * *"]),
    ];
    expect(groupRoutinesBySchedule(routines, labels, "en")).toHaveLength(1);
    expect(outline(routines)).toEqual([["daily", ["daily @ 9:00 AM", "paused-daily @ 6:00 PM"]]]);
  });

  it("groups by the first schedule when a routine has several", () => {
    const routines = [routine("mixed", ["0 9 1 * *", "0 18 * * *"])];
    expect(outline(routines)).toEqual([["monthly", ["mixed @ on the 1st at 9:00 AM"]]]);
  });

  it("leaves a malformed schedule readable instead of throwing", () => {
    expect(outline([routine("broken", ["nonsense"])])).toEqual([
      ["other", ["broken @ Cron nonsense"]],
    ]);
  });
});
