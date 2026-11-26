import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollaborationMarker, WorkingIndicator } from "./CollaborationMarker";

describe("collaboration transcript markers", () => {
  it("shows a centred peer event with its avatar and full label", () => {
    const html = renderToString(
      <CollaborationMarker
        peerName="Research"
        color="#14B8A6"
        identity="research"
        label="Message from Research"
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="peer-receipt-chip"');
    expect(html).toContain('aria-label="Message from Research"');
    expect(html).toContain('class="flex min-w-0 max-w-full justify-center py-1"');
    expect(html).toContain('class="inline-flex max-w-full');
    expect(html).toContain("truncate font-medium");
    expect(html).toContain("livingbot-organic-avatar");
    expect(html).toContain("Message from Research");
    expect(html).not.toContain("{peer}");
    expect(html).not.toContain("peer-replies-toggle");
  });

  it("shows the current activity without repeating the reply avatar", () => {
    const html = renderToString(
      <WorkingIndicator label="Searching the web: injury news" />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Searching the web: injury news");
    expect(html).toContain("text-shimmer");
    expect(html).not.toContain("livingbot-organic-avatar");
    expect(html).not.toContain("<img");
  });
});
