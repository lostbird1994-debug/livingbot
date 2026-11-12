export function HighlightedText({ text, query }: { text: string; query: string }) {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 ? (
          <mark
            key={`${index}:${part}`}
            className="rounded-sm bg-accent font-medium text-accent-foreground underline decoration-primary/40 underline-offset-2"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
