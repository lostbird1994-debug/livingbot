// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { Bot } from "@rakazo/contracts";
import { botRoleCard } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ update: vi.fn(), get: vi.fn() }));
vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => ({ bots: api }) }));
vi.mock("../components/InstructionSettings", () => ({
  InstructionSettings: () => <div>Instructions editor</div>,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Disclosure: ({
    summary,
    children,
    open,
    onOpenChange,
  }: {
    summary: ReactNode;
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button
        type="button"
        data-disclosure-summary
        aria-expanded={open}
        onClick={() => onOpenChange?.(!open)}
      >
        {summary}
      </button>
      {children}
    </div>
  ),
  SectionHeading: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: ComponentProps<"button"> & {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
}));

import { BotRoleCardEditor } from "./BotRoleCardEditor";

let root: Root;
let host: HTMLDivElement;
const initial = { id: "bot", instructions: "Private", roleCard: botRoleCard(undefined) } as Bot;
const saved = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
  api.update.mockReset();
  api.get.mockReset();
  saved.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render(bot = initial) {
  await act(async () => root.render(<BotRoleCardEditor bot={bot} onSaved={saved} />));
}
async function type(label: string, value: string) {
  const field = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
  await act(async () => button.click());
}
it("shows the preview only while a role or instructions card is collapsed", async () => {
  await render({
    ...initial,
    roleCard: botRoleCard({ identity: "A librarian", personality: "Patient" }),
  });
  const identity = host.querySelectorAll<HTMLButtonElement>("[data-disclosure-summary]")[0]!;
  expect(identity.textContent).toContain("A librarian");
  await act(async () => identity.click());
  expect(identity.textContent).not.toContain("A librarian");
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Identity"]')!.value).toBe(
    "A librarian",
  );
  await act(async () => identity.click());
  expect(identity.textContent).toContain("A librarian");
  const instructions = host.querySelectorAll<HTMLButtonElement>("[data-disclosure-summary]")[1]!;
  expect(instructions.textContent).toContain("Private");
  await act(async () => instructions.click());
  expect(instructions.textContent).not.toContain("Private");
});
it("saves identity modules with a baseline and no retired modules or switches", async () => {
  api.update.mockImplementation(async ({ roleCard }) => ({ ...initial, roleCard }));
  await render();
  await type("Identity", "A librarian");
  await type("User identity", "A visitor");
  expect(host.querySelector('[aria-label="Enable user identity"]')).toBeNull();
  expect(host.querySelector('[aria-label="Enable backstory"]')).toBeNull();
  expect(host.querySelector('[aria-label="Backstory"]')).toBeNull();
  await click("Save role settings");
  expect(api.update).toHaveBeenCalledExactlyOnceWith({
    botId: "bot",
    roleCard: {
      ...initial.roleCard,
      identity: "A librarian",
      userIdentity: "A visitor",
    },
    expectedRoleCard: initial.roleCard,
  });
  expect(saved).toHaveBeenCalledOnce();
});
it("keeps unsaved drafts across a bot refresh", async () => {
  await render();
  await type("Personality", "Patient draft");
  await render({
    ...initial,
    roleCard: { ...initial.roleCard!, personality: "Concurrent saved text" },
  });
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Personality"]')!.value).toBe(
    "Patient draft",
  );
});
it("preserves a conflict draft until an explicit reload, then saves against the latest baseline", async () => {
  api.update.mockRejectedValueOnce(new ORPCError("CONFLICT", { message: "changed" }));
  const latest = { ...initial, roleCard: botRoleCard({ personality: "Concurrent saved text" }) };
  api.get.mockResolvedValue(latest);
  await render();
  await type("Personality", "Draft");
  await click("Save role settings");
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Personality"]')!.value).toBe(
    "Draft",
  );
  expect(
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Save role settings")!
      .disabled,
  ).toBe(true);
  await click("Reload");
  await type("Personality", "Fresh draft");
  api.update.mockResolvedValue({
    ...latest,
    roleCard: { ...latest.roleCard, personality: "Fresh draft" },
  });
  await click("Save role settings");
  expect(api.update.mock.lastCall?.[0].expectedRoleCard).toEqual(latest.roleCard);
});
