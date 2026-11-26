/** Input guidance checks; the isolated browser host remains the execution boundary. */
export function validateWidgetCode(code: string, format: "svg" | "html"): string | undefined {
  if (/<(?:!doctype|html|head|body|base|meta|iframe|object|embed|form)\b/i.test(code))
    return "Provide a fragment without document wrappers, nested browsing contexts or forms.";
  if (/\b(?:localStorage|sessionStorage|document\.cookie)\b/.test(code))
    return "Widgets have no persistent browser storage or cookies. Keep state in memory.";
  if (/position\s*:\s*fixed\b/i.test(code))
    return "Use in-flow layout instead of fixed positioning.";
  if (
    format === "svg" &&
    (!/^<svg\b/i.test(code.trim()) ||
      (code.match(/<svg\b/gi) ?? []).length !== 1 ||
      !/viewBox\s*=\s*["']0\s+0\s+680\s+[\d.]+["']/i.test(code))
  )
    return "Provide one SVG with viewBox='0 0 680 H'.";
  return undefined;
}
