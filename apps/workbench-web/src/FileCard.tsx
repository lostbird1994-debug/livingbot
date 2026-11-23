import { useEffect, useRef, useState } from "react";
import { Download, Eye, FileText, X } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import type { WorkbenchClient } from "./client.ts";
import { Content, PreviewFrame } from "./Document.tsx";

export function FileCard({ id, name, mediaType, client }: {
  id: string; name: string; mediaType: string; client: WorkbenchClient;
}) {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<string>();
  const [image, setImage] = useState<string>();
  const previewElement = useRef<HTMLDivElement>(null);
  const textPreview = mediaType.startsWith("text/") || ["application/json", "application/xml", "image/svg+xml"].includes(mediaType);
  const imagePreview = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].includes(mediaType);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);
  useEffect(() => {
    if (text !== undefined || image) previewElement.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [text, image]);
  async function open(preview: boolean) {
    setLoading(true); setError(undefined);
    try {
      const blob = await client.file(id);
      if (preview) {
        if (imagePreview) setImage(URL.createObjectURL(blob));
        else {
          if (blob.size > 2 * 1024 * 1024) throw new Error("文件较大，请下载查看");
          setText(await blob.text());
        }
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }
  return <div className="file-delivery">
    <div className="file-card"><FileText size={19} /><span>{name}</span>
      {(textPreview || imagePreview) && <Button type="button" variant="ghost" size="icon-sm" disabled={loading} aria-label={`预览 ${name}`} onClick={() => void open(true)}><Eye /></Button>}
      <Button type="button" variant="ghost" size="icon-sm" disabled={loading} aria-label={`下载 ${name}`} onClick={() => void open(false)}><Download /></Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {(text !== undefined || image) && <div className="file-preview" ref={previewElement}><Button type="button" variant="ghost" size="icon-sm" aria-label={`关闭 ${name} 预览`} onClick={() => { setText(undefined); setImage(undefined); }}><X /></Button>
      {image ? <img src={image} alt={name} /> : text !== undefined &&
        (/^(text\/html|image\/svg\+xml)$/.test(mediaType) ? <PreviewFrame source={text} title={`${name} 预览`} />
          : mediaType === "text/markdown" || /\.md$|\.markdown$/i.test(name) ? <div className="document-body"><Content text={text} /></div> : <pre>{text}</pre>)}
    </div>}
  </div>;
}
