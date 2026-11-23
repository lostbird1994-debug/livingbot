// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { useShellNavigation } from "./use-shell-navigation";

vi.mock("../../lib/space-switch", () => ({
  guardShellNavigate:
    (getNavigate: () => (to: unknown, options?: unknown) => void, alive: () => boolean) =>
    (to: unknown, options?: unknown) => {
      if (alive()) getNavigate()(to, options);
    },
}));

it("holds workspace navigation and overlays until a settings save finishes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let navigation: ReturnType<typeof useShellNavigation>;
  function Probe({ blocked }: { blocked: boolean }) {
    navigation = useShellNavigation(blocked);
    const location = useLocation();
    return <output>{location.pathname + location.search}</output>;
  }
  const render = async (blocked: boolean) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/app/bot-1?settings=voice"]}>
          <Probe blocked={blocked} />
        </MemoryRouter>,
      );
    });
  };
  try {
    await render(true);
    await act(async () => {
      navigation.navigate("/app?view=bots");
      navigation.setOverlay(null);
      navigation.redirectKeepingOverlay("/app/bot-2");
    });
    expect(container.textContent).toBe("/app/bot-1?settings=voice");
    await render(false);
    await act(async () => navigation.navigate("/app?view=bots"));
    expect(container.textContent).toBe("/app?view=bots");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
