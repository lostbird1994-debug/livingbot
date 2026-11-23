// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SkillDocumentView } from "./skill-document";
vi.mock("@livingbot/chat-ui/web", () => ({ ChatMarkdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@livingbot/ui-web", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button>, NativeSelect: (props: any) => <select {...props} />, NativeSelectOption: (props: any) => <option {...props} /> }));
vi.mock("../../components/ai/primitives", () => ({ LoadingState: () => <p>Loading</p> }));
it("reads actual skill files, keeps metadata separate and requests modification without editing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const query = new QueryClient({defaultOptions:{queries:{retry:false}}}); const modify = vi.fn();
  const load = vi.fn(async (path: string) => ({ skill:{ key:"workshop:guide",name:"guide",description:"",source:"openclaw-workshop" }, path, content:path === "SKILL.md" ? "---\nname: guide\n---\n# Actual procedure" : "Support instructions", files:["SKILL.md","references/check.md"], changes:[{at:1,kind:"patch",reason:"Repair procedure"}] }));
  try {
    await act(async () => {root.render(<QueryClientProvider client={query}><SkillDocumentView identity="guide" load={load} onModify={modify} /></QueryClientProvider>);});
    await act(async () => {await new Promise(r=>setTimeout(r,20));});
    expect(container.textContent).toContain("Actual procedure"); expect(container.querySelectorAll("textarea,input").length).toBe(0);
    await act(async()=>{(container.querySelector("button") as HTMLButtonElement).click();});expect(modify).toHaveBeenCalledOnce();
    await act(async()=>{const select=container.querySelector("select")!; select.value="references/check.md"; select.dispatchEvent(new Event("change",{bubbles:true}));});
    await act(async()=>{await new Promise(r=>setTimeout(r,20));});expect(load).toHaveBeenCalledWith("references/check.md"); expect(container.textContent).toContain("Support instructions");expect(container.textContent).toContain("Repair procedure");
  } finally {await act(async()=>root.unmount());container.remove();query.clear();}
});
