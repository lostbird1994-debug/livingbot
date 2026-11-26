// @vitest-environment jsdom
import type { ThreadMessage } from "@livingbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTurnTitleBackfill } from "./turn-title-backfill";

it("makes no title requests while disabled and resumes when enabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const messages = [{ id: "u1", role: "user" }] as ThreadMessage[];
  const request = vi.fn(async () => {});
  const named = vi.fn();
  function Probe({ enabled }: { enabled: boolean }) {
    useTurnTitleBackfill(messages, request, named, enabled);
    return null;
  }
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<Probe enabled={false} />);
    });
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<Probe enabled />);
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(["u1"]);
    expect(named).toHaveBeenCalledOnce();
    await act(async () => {
      root.render(<Probe enabled={false} />);
    });
    await act(async () => {
      root.render(<Probe enabled />);
    });
    expect(request).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
