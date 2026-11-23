// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NativePreviewFrame } from "@livingbot/ui-web/native-preview";

it("accepts resize and prompt channels only from the owned frame and requires user activation", async () => {
  const container=document.createElement("div");document.body.append(container);
  const root=createRoot(container), prompt=vi.fn();
  await act(async()=>root.render(<NativePreviewFrame source="<p>Example</p>" nativeDocument onPrompt={prompt}/>));
  const frame=container.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  await act(async()=>window.dispatchEvent(new MessageEvent("message",{source:window,data:{type:"openclaw:widget-size",height:999}})));
  expect(frame.style.height).toBe("340px");
  await act(async()=>window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,data:{type:"openclaw:widget-size",height:420}})));
  expect(frame.style.height).toBe("420px");
  const port={close:vi.fn(),start:vi.fn(),postMessage:vi.fn(),onmessage:undefined as ((event:{data:unknown})=>void)|undefined};
  const offer=new MessageEvent("message",{source:frame.contentWindow,data:{type:"openclaw:widget-prompt-offer"}});
  Object.defineProperty(offer,"ports",{value:[port]});window.dispatchEvent(offer);
  const old=Object.getOwnPropertyDescriptor(navigator,"userActivation");
  try {
    Object.defineProperty(navigator,"userActivation",{configurable:true,value:{isActive:false}});
    port.onmessage?.({data:{type:"openclaw:widget-prompt",prompt:"Synthetic prompt"}});
    expect(prompt).not.toHaveBeenCalled();
    Object.defineProperty(navigator,"userActivation",{configurable:true,value:{isActive:true}});
    port.onmessage?.({data:{type:"openclaw:widget-prompt",prompt:"Synthetic prompt"}});
    expect(prompt).toHaveBeenCalledExactlyOnceWith("Synthetic prompt");
  } finally {
    if(old)Object.defineProperty(navigator,"userActivation",old);else Reflect.deleteProperty(navigator,"userActivation");
    await act(async()=>root.unmount());container.remove();
  }
});
