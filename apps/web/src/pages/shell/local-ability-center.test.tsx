// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Ability } from "../../../../../packages/workbench/src/contracts";
import { createLocalAbilitiesClient } from "../../lib/local-abilities";
import { LocalAbilityCenter } from "./local-ability-center";

// Exercise shared inventory behavior; Base UI's own React runtime is outside
// this isolated frontend fixture's dependency tree.
vi.mock("@livingbot/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
  Input: (props: object) => <input {...props} />,
  NativeSelect: (props: object) => <select {...props} />,
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  SheetContent: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

it("keeps the whole shared inventory scrollable and writes a common policy without choosing a Bot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const calls: string[] = [];
  const items: Ability[] = Array.from({ length: 25 }, (_, index) => ({
    id: `shared:${index}`,
    name: `文档工具 ${index}`,
    description: "处理工作文档",
    kind: "tool",
    source: "core",
    version: "native",
    permissions: [],
    botIds: [],
    state: "enabled",
    configuration: {
      native: { nativeKind: "tool", nativeName: `documents-${index}` },
      sharedAccess: { enabled: true, ready: true, manageable: true },
    },
  }));
  const client = createLocalAbilitiesClient(async <T,>(path: string, init?: RequestInit) => {
    calls.push(path);
    if (path.endsWith("/access")) {
      expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
      items[0]!.configuration!.sharedAccess = { enabled: false, ready: false, manageable: true };
    }
    return items as T;
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LocalAbilityCenter client={client} renderConnections={() => null} />
        </QueryClientProvider>,
      );
      await queryClient.fetchQuery({
        queryKey: ["local-abilities", "shared"],
        queryFn: client.refreshShared,
      });
    });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(25);
    expect(container.textContent).toContain("所有 Bot 共用");
    expect(container.textContent).not.toContain("GitHub 市场");
    expect(container.textContent).not.toContain("下一页");
    expect(calls).toEqual(["/api/abilities/refresh"]);
    await act(async () => {
      (container.querySelector('[role="switch"]') as HTMLButtonElement).click();
    });
    expect(calls).toContain("/api/abilities/shared%3A0/access");
    expect(calls.some((path) => path.includes("/bots/"))).toBe(false);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("configuration starts administrator guidance for the selected ability instead of opening its detail sheet", async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const item={id:"native:global:service:mail",name:"Mail",description:"Synthetic mail connection",version:"1",permissions:[],botIds:[],kind:"service",source:"mcp",state:"enabled",configuration:{native:{nativeKind:"service",nativeName:"mail"},sharedAccess:{enabled:true,ready:false,manageable:true,reason:"Authorization required"}}} as Ability;
 const client=createLocalAbilitiesClient(async<T,>()=>[item] as T);const configure=vi.fn(async()=>{});const query=new QueryClient({defaultOptions:{queries:{retry:false}}});const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 try{await act(async()=>{root.render(<QueryClientProvider client={query}><LocalAbilityCenter client={client} onConfigure={configure} renderConnections={()=> <div>Secure connection form</div>}/></QueryClientProvider>);await query.fetchQuery({queryKey:["local-abilities","shared"],queryFn:client.refreshShared});});
 const button=[...host.querySelectorAll("button")].find(x=>x.textContent==="配置")!;await act(async()=>button.click());expect(configure).toHaveBeenCalledWith(item.id);expect(host.querySelector("aside")).toBeNull();expect(host.textContent).not.toContain("Secure connection form");
 }finally{await act(async()=>root.unmount());host.remove();query.clear();vi.unstubAllGlobals();}
});
