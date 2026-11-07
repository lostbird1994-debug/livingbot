export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Characters as a reader counts them: one CJK character is 1, not the 3 bytes it occupies.
 * Budgets that describe what a person typed are counted this way; budgets that describe what
 * a transport carries are counted in bytes.
 */
export function charLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // A surrogate pair is one character, so skip its second half.
    if (code >= 0xd800 && code <= 0xdbff) index += 1;
    count += 1;
  }
  return count;
}

export function truncateChars(
  value: string,
  maxChars: number,
  keep: "start" | "end" = "start",
): string {
  if (maxChars <= 0) return "";
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  return keep === "end"
    ? characters.slice(characters.length - maxChars).join("")
    : characters.slice(0, maxChars).join("");
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
  keep: "start" | "end" = "start",
): string {
  if (maxBytes <= 0) return "";
  if (keep === "end") {
    let start = value.length;
    let bytes = 0;
    while (start > 0) {
      let nextStart = start - 1;
      const code = value.charCodeAt(nextStart);
      const previous = value.charCodeAt(nextStart - 1);
      if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
        nextStart -= 1;
      }
      const characterBytes = byteLength(value.slice(nextStart, start));
      if (bytes + characterBytes > maxBytes) break;
      bytes += characterBytes;
      start = nextStart;
    }
    return value.slice(start);
  }
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}
