// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { useFindRequest } from "./use-find-request";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let latest: readonly [boolean, (open: boolean) => void] = [false, () => {}];
  function Probe({ value }: { value: number }) {
    latest = useFindRequest(value);
    return null;
  }
  const render = async (value: number) => {
    await act(async () => root.render(createElement(Probe, { value })));
  };
  return { render, root, open: () => latest[0] };
}

it("stays closed when it mounts on a request value it inherited", async () => {
  const view = mount();
  await view.render(3);
  expect(view.open()).toBe(false);
  await act(async () => view.root.unmount());
});

it("opens when the request changes while mounted", async () => {
  const view = mount();
  await view.render(0);
  expect(view.open()).toBe(false);
  await view.render(1);
  expect(view.open()).toBe(true);
  await act(async () => view.root.unmount());
});

it("does not reopen on a later remount that keeps the handled value", async () => {
  const first = mount();
  await first.render(1);
  expect(first.open()).toBe(false);
  await first.render(2);
  expect(first.open()).toBe(true);
  await act(async () => first.root.unmount());

  const second = mount();
  await second.render(2);
  expect(second.open()).toBe(false);
  await act(async () => second.root.unmount());
});
