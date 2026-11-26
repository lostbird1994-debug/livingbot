/**
 * The chat reads as one column of a fixed measure instead of stretching across
 * a wide window. At body-1 (14px) the default keeps a line near 46 characters, so
 * the eye never sweeps far to find the next one and a long reply stops reading as a
 * wall of text. The width setting picks among these.
 */
export const CHAT_WIDTH_MEASURE = {
  narrow: "34rem",
  default: "40rem",
  wide: "52rem",
} as const;

/**
 * Padding grows once the pane is wider than the measure, which centers the
 * column and turns the rest into margin; below it the floor is the phone
 * gutter. The transcript and the composer share this so their edges line up.
 *
 * The class reads `--rk-chat-measure`, so the width setting moves the column
 * without touching a component.
 */
export const CHAT_COLUMN_PADDING = "rk-chat-column";
