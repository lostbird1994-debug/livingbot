// @vitest-environment jsdom
import type { Bot } from "@livingbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeleteBotDialog } from "./dialogs";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "") }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: () => null,
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host=document.createElement("div");document.body.append(host);root=createRoot(host); });
afterEach(async () => { await act(async()=>root.unmount());host.remove();vi.restoreAllMocks(); });

it.each([false,true])("confirms permanent deletion with the selected memory choice (%s)",async(deleteMemories)=>{
 const confirm=vi.fn(async()=>{});
 await act(async()=>root.render(<DeleteBotDialog bot={{name:"Synthetic Bot"} as Bot} onCancel={vi.fn()} onConfirm={confirm}/>));
 expect(document.body.textContent).toContain("permanently deleted");
 expect(confirm).not.toHaveBeenCalled();
 const radios=[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
 expect(radios).toHaveLength(2);
 expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
 if(deleteMemories)await act(async()=>radios[1]!.click());
 const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(x=>x.textContent==='Delete');
 expect(button).toBeTruthy();await act(async()=>button!.click());
 expect(confirm).toHaveBeenCalledExactlyOnceWith(deleteMemories);
});
