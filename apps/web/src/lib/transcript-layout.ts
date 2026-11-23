/**
 * The chat reads as one column of a fixed measure instead of stretching across
 * a wide window. At body-1 (14px) this keeps a line near 46 characters, so the
 * eye never sweeps far to find the next one and a long reply stops reading as a
 * wall of text.
 */
export const CHAT_COLUMN_MEASURE = "40rem";

/**
 * Padding grows once the pane is wider than the measure, which centers the
 * column and turns the rest into margin; below it the floor is the phone
 * gutter. The transcript and the composer share this so their edges line up.
 */
export const CHAT_COLUMN_PADDING = "px-[max(1rem,calc((100%_-_40rem)/2))]";
