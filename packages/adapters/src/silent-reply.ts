import type { MessageBlock } from "@livingbot/contracts";

/** Exact token a silent run must emit as its entire final assistant reply. */
export const NO_RESPONSE = "NO_RESPONSE";

/**
 * Workspaces imported from OpenClaw and routine prompts written against it say
 * `NO_REPLY` for the same choice. Instructions only ever teach `NO_RESPONSE`,
 * but a run that answers with the older token is staying silent too, so it is
 * swallowed rather than posted as chat text.
 */
export const LEGACY_NO_RESPONSE = "NO_REPLY";

/** Every token that means "nothing to report". */
const SILENT_SENTINELS = [NO_RESPONSE, LEGACY_NO_RESPONSE] as const;

const SHORTEST_SENTINEL = Math.min(...SILENT_SENTINELS.map((token) => token.length));

/** The sentinel starting at `index`, if any. */
function sentinelAt(text: string, index: number): string | undefined {
  return SILENT_SENTINELS.find((token) => text.startsWith(token, index));
}

/** The sentinel ending at `index`, if any. */
function sentinelEndingAt(text: string, index: number): string | undefined {
  return SILENT_SENTINELS.find((token) => text.endsWith(token, index));
}

function textBlocksOf(
  blocks: readonly MessageBlock[],
): Array<Extract<MessageBlock, { kind: "text" }>> {
  return blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
  );
}

function joinedText(blocks: readonly MessageBlock[]): string {
  return textBlocksOf(blocks)
    .map((block) => block.text)
    .join("");
}

/**
 * The sentinel alone, once or repeated. Text segments of one turn are joined
 * with no separator, so a model that re-emits the sentinel after each tool
 * batch yields `NO_RESPONSENO_RESPONSE`; that is still a silent reply, not prose.
 */
const SENTINEL_ONLY = new RegExp(`^(?:${SILENT_SENTINELS.join("|")}\\s*)+$`);

/** True when trimmed text is only the silent-reply sentinel, once or repeated. Extra prose does not match. */
export function isExactNoResponse(text: string): boolean {
  return SENTINEL_ONLY.test(text.trim());
}

/** True when a whole sentinel word appears anywhere in the text. */
const MENTIONS_SENTINEL = new RegExp(`\\b(?:${SILENT_SENTINELS.join("|")})\\b`);

/** Whether the text mentions a sentinel at all, as when prose pairs it with a report. */
export function mentionsNoResponse(text: string): boolean {
  return MENTIONS_SENTINEL.test(text);
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;

/**
 * Edge runs of the sentinel, glued or spaced. Each token must end at a word
 * boundary to count: a token that continues into an identifier such as
 * `NO_RESPONSE_POLICY` is a word, so the run stops at the last clean token
 * before it instead of being abandoned altogether.
 */
function proseRange(text: string): { start: number; end: number } {
  let cursor = text.length - text.trimStart().length;
  let start = 0;
  let token = sentinelAt(text, cursor);
  while (token) {
    cursor += token.length;
    if (!IDENTIFIER_CHAR.test(text[cursor] ?? "")) {
      while (cursor < text.length && WHITESPACE.test(text[cursor]!)) cursor++;
      start = cursor;
      token = sentinelAt(text, cursor);
    } else {
      const glued = sentinelAt(text, cursor);
      if (!glued) break;
      token = glued;
    }
  }
  // Scan backwards from the end so long whitespace cannot cause suffix backtracking.
  cursor = text.trimEnd().length;
  let end = text.length;
  token = sentinelEndingAt(text, cursor);
  while (token && cursor - token.length >= start) {
    cursor -= token.length;
    if (cursor <= start || !IDENTIFIER_CHAR.test(text[cursor - 1] ?? "")) {
      while (cursor > start && WHITESPACE.test(text[cursor - 1]!)) cursor--;
      end = cursor;
      token = sentinelEndingAt(text, cursor);
    } else {
      const glued =
        cursor - SHORTEST_SENTINEL >= start ? sentinelEndingAt(text, cursor) : undefined;
      if (!glued) break;
      token = glued;
    }
  }
  return { start, end };
}

/**
 * Silent-reply stripper. If the trimmed final text is exactly a silence token,
 * drop that text so the run can finish with no chat bubble. Sibling tool/step
 * blocks do not count as extra prose. Surrounding words keep the reply; only a
 * stray sentinel at the start or end of that prose is removed from it.
 */
export function stripNoResponseReply(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const assembledTrimmed = assembled.trim();
  const blockText = joinedText(blocks).trim();
  const visible = assembledTrimmed || blockText;
  if (!isExactNoResponse(visible)) return withoutStraySentinelsAtEdges(assembled, blocks);
  // Fail closed: extra prose in either the assembled final or a text block keeps the reply.
  if (assembledTrimmed && blockText && !isExactNoResponse(blockText)) {
    return { assembled, blocks };
  }
  return {
    assembled: "",
    blocks: blocks.filter((block) => block.kind !== "text"),
  };
}

/**
 * For runs that must reply: drop stray sentinels at the edges of a reply with
 * prose, such as one a late follow-up message adds after the final answer.
 * A sentinel-only reply is left as is, so the run still says something.
 */
export function stripStrayNoResponse(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const visible = assembled.trim() || joinedText(blocks).trim();
  if (isExactNoResponse(visible)) return { assembled, blocks };
  return withoutStraySentinelsAtEdges(assembled, blocks);
}

/** What a bot asked by another bot returns when it answers with only the sentinel. */
export const PEER_NOTHING_NEW_REPLY = "Nothing new to add.";

/**
 * For a request or question from another bot: a sentinel-only reply would reach the
 * asker as the literal token, so say it in words instead. Other replies are handled as above.
 */
export function peerReplyWithoutSentinel(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const visible = assembled.trim() || joinedText(blocks).trim();
  if (!isExactNoResponse(visible)) return stripStrayNoResponse(assembled, blocks);
  return {
    assembled: PEER_NOTHING_NEW_REPLY,
    blocks: [
      ...blocks.filter((block) => block.kind !== "text"),
      { kind: "text", text: PEER_NOTHING_NEW_REPLY },
    ],
  };
}

/** A reply with prose stays a reply; a sentinel misplaced at its edge is dropped from what the user sees. */
function withoutStraySentinelsAtEdges(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const assembledRange = proseRange(assembled);
  const cleanedAssembled = assembled.slice(assembledRange.start, assembledRange.end);
  const blockText = joinedText(blocks);
  const { start, end } = proseRange(blockText);
  if (start === 0 && end === blockText.length) {
    return { assembled: cleanedAssembled, blocks };
  }

  let offset = 0;
  const cleanedBlocks = blocks.flatMap<MessageBlock>((block) => {
    if (block.kind !== "text") return [block];
    const blockStart = offset;
    offset += block.text.length;
    const text = block.text.slice(Math.max(0, start - blockStart), Math.max(0, end - blockStart));
    if (text === block.text) return [block];
    return text ? [{ ...block, text }] : [];
  });
  return { assembled: cleanedAssembled, blocks: cleanedBlocks };
}
