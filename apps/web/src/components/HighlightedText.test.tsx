import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HighlightedText } from "./HighlightedText";

it.each(["(", "[", "*", "报告(2026)", "a+b", "a.b", "?"])(
  "treats the search term as literal text: %s",
  (query) => {
    const result = renderToStaticMarkup(
      <HighlightedText text={`before ${query} after`} query={query} />,
    );
    expect(result).toContain(`<mark`);
    expect(result).toContain(`>${query}</mark>`);
  },
);
