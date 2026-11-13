import type { ThreadStopContext } from "@livingbot/db";
import { describe, expect, it } from "vitest";
import {
  CANCELLED_HISTORY_NOTE,
  stoppedHistoryText,
  stoppedWorkInstruction,
} from "./stopped-work.js";

const context: ThreadStopContext = {
  stoppedAt: "2026-10-01T10:00:00.000Z",
  throughMessageSeq: 5,
  cancelledMessageIds: ["cancelled"],
};
describe("stopped work instructions", () => {
  it("marks only cancelled user requests while preserving original text", () => {
    expect(stoppedHistoryText({ id: "cancelled", role: "user" }, "Previous task", context)).toBe(
      `${CANCELLED_HISTORY_NOTE}\nPrevious task`,
    );
    expect(stoppedHistoryText({ id: "fresh", role: "user" }, "New task", context)).toBe("New task");
    expect(
      stoppedHistoryText({ id: "cancelled", role: "bot" }, "Already wrote file", context),
    ).toBe("Already wrote file");
  });
  it("keeps a separate instruction when no old messages remain", () => {
    expect(stoppedWorkInstruction({ ...context, cancelledMessageIds: [] })).toBe(
      stoppedWorkInstruction(context),
    );
    expect(stoppedWorkInstruction(undefined)).toBeUndefined();
    expect(stoppedHistoryText({ id: "fresh", role: "user" }, "New task", undefined)).toBe(
      "New task",
    );
  });
});
