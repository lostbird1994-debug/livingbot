import { Button, Textarea } from "@livingbot/ui-web";
import { useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

const labels = {
  "AGENTS.md": "指令",
  "IDENTITY.md": "身份",
  "SOUL.md": "性格",
  "USER.md": "用户身份",
  "MEMORY.md": "记忆",
  "TOOLS.md": "工具说明",
  "HEARTBEAT.md": "定期检查",
  "BOOTSTRAP.md": "初始化引导",
} as const;
const knownDocument = (name: string): name is keyof typeof labels => Object.hasOwn(labels, name);
export function contextDocumentLabel(name: string) {
  const filename = name.replace(/^工作区共享\//, "");
  return knownDocument(filename) ? `${filename}（${labels[filename]}）` : filename;
}
type Document = {
  name: string;
  scope: "bot" | "user";
  content: string;
  excerpt: string;
  shownChars: number;
  totalChars: number;
};

/** Edits the complete source with a preimage check; display labels never become paths. */
export function NativeContextDocument({
  botId,
  document: doc,
  onSaved,
}: {
  botId: string;
  document: Document;
  onSaved(): Promise<unknown>;
}) {
  const rpc = useSpaceRpc();
  const [draft, setDraft] = useState<string | null>(null);
  const [baseline, setBaseline] = useState("");
  const [saved, setSaved] = useState<{ source: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const content = saved?.source === doc.content ? saved.content : doc.content;
  const name = doc.name.replace(/^工作区共享\//, "");
  const editable = knownDocument(name);
  async function save() {
    if (draft === null || busy || !knownDocument(name)) return;
    setBusy(true);
    setError("");
    try {
      await rpc.memory.updateContextDocument({
        botId,
        scope: doc.scope,
        name,
        content: draft,
        expectedContent: baseline,
      });
      setSaved({ source: doc.content, content: draft });
      setDraft(null);
      await onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 space-y-3">
      {draft === null ? (
        <>
          <p className="text-xs font-medium text-muted-foreground">完整正文</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-xs leading-relaxed">
            {content || "暂无内容"}
          </pre>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {editable ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBaseline(content);
                  setDraft(content);
                  setError("");
                }}
              >
                编辑
              </Button>
            ) : null}
          </div>
          {doc.excerpt.trimEnd() !== doc.content.trimEnd() ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">查看实际加载片段</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {doc.excerpt || "本次未加载正文"}
              </pre>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <p className="sticky top-0 z-10 bg-card py-2 text-xs font-medium">
            正在编辑：{contextDocumentLabel(doc.name)}{doc.scope === "user" ? " · 工作区共享" : ""}
          </p>
          <Textarea
            aria-label={contextDocumentLabel(doc.name)}
            value={draft}
            rows={10}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            className="max-h-96 min-h-48 resize-y bg-muted/50 text-sm leading-relaxed"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy || draft === baseline} onClick={() => void save()}>
              {busy ? "保存中…" : "保存"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError("");
              }}
            >
              取消
            </Button>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
