// @vitest-environment jsdom
import { act } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hydrateBotVoicePreferences,
  readBotVoicePreferences,
} from "../../lib/voice-assistant-pref";
import { BotVoiceSettings } from "./BotVoiceSettings";

vi.mock("@livingbot/ui-web", () => ({
  SectionHeading: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  Button: ({ size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string }) =>
    <button {...props} />,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Switch: ({ checked, onCheckedChange, ...props }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id: string;
    disabled?: boolean;
  }) => <input {...props} type="checkbox" checked={checked}
    onChange={(event) => onCheckedChange(event.target.checked)} />,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const off = { wakeEnabled: false, notifyEnabled: false, aliases: [] };

beforeEach(() => {
  localStorage.clear();
  hydrateBotVoicePreferences({}, async () => undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function notificationSwitch() {
  return host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
}

it("updates mounted controls when durable preferences are hydrated and the bot changes", async () => {
  await act(async () => root.render(<BotVoiceSettings bot={{ id: "a", name: "Bot A" }} />));
  expect(notificationSwitch().checked).toBe(false);
  await act(async () => {
    hydrateBotVoicePreferences({
      "rakazo:bot-voice:a": { ...off, notifyEnabled: true },
    }, async () => undefined);
  });
  expect(notificationSwitch().checked).toBe(true);
  await act(async () => root.render(<BotVoiceSettings bot={{ id: "b", name: "Bot B" }} />));
  expect(notificationSwitch().checked).toBe(false);
});

it("waits for durable acknowledgement and displays a failed save without changing the switch", async () => {
  let rejectSave!: (reason: Error) => void;
  const save = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
  hydrateBotVoicePreferences({}, save);
  await act(async () => root.render(<BotVoiceSettings bot={{ id: "a", name: "Bot A" }} />));
  await act(async () => notificationSwitch().click());
  expect(save).toHaveBeenCalledWith({
    "rakazo:bot-voice:a": { ...off, notifyEnabled: true },
  });
  expect(notificationSwitch().disabled).toBe(true);
  expect(notificationSwitch().checked).toBe(false);
  await act(async () => rejectSave(new Error("Unavailable")));
  expect(notificationSwitch().disabled).toBe(false);
  expect(notificationSwitch().checked).toBe(false);
  expect(readBotVoicePreferences("a")).toEqual(off);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("无法保存语音设置，请重试。");
});

it("renders successful durable saves immediately", async () => {
  await act(async () => root.render(<BotVoiceSettings bot={{ id: "a", name: "Bot A" }} />));
  await act(async () => notificationSwitch().click());
  expect(notificationSwitch().checked).toBe(true);
  expect(readBotVoicePreferences("a").notifyEnabled).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
