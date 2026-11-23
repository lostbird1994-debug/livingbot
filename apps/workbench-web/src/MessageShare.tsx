import { useEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@livingbot/ui-web/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@livingbot/ui-web/components/ui/native-select";
import type { ContextShare, Conversation, Message } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchClient } from "./client.ts";

export function MessageShare({ message, groups, client }: {
  message: Message; groups: Conversation[]; client: WorkbenchClient;
}) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<ContextShare[]>();
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const request = useRef<{ id: string; destination: string } | undefined>(undefined);
  const lock = useRef(false);
  const text = message.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setShares(undefined); setError(undefined);
    void client.request<{ shares: ContextShare[] }>(
      `/api/context-shares?sourceConversationId=${encodeURIComponent(message.conversationId)}`,
    ).then(({ shares }) => {
      if (active) setShares(shares.filter((share) => share.messageIds.includes(message.id)));
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取共享记录"); });
    return () => { active = false; };
  }, [client, message.conversationId, message.id, open]);
  async function share() {
    if (lock.current || !destination || !shares) return;
    lock.current = true; setSaving(true); setError(undefined);
    request.current ??= { id: crypto.randomUUID(), destination };
    try {
      const result = await client.request<ContextShare>("/api/context-shares", {
        id: request.current.id, sourceConversationId: message.conversationId,
        destinationConversationId: request.current.destination, messageIds: [message.id],
      });
      setShares((items) => [...(items ?? []).filter((share) => share.id !== result.id), result].filter((share) => !share.revokedAt));
      request.current = undefined; setDestination("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "共享尚未确认"); }
    finally { lock.current = false; setSaving(false); }
  }
  async function revoke(id: string) {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError(undefined);
    try {
      await client.request(`/api/context-shares/${encodeURIComponent(id)}/revoke`, {});
      setShares((items) => items?.filter((share) => share.id !== id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "停止共享尚未确认"); }
    finally { lock.current = false; setSaving(false); }
  }
  const available = groups.filter((group) => !shares?.some((share) => share.destinationConversationId === group.id));
  return <>
    <Button type="button" size="icon-sm" variant="ghost" aria-label="共享这条消息" onClick={() => setOpen(true)}><Share2 /></Button>
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <DialogContent>
        <DialogTitle>共享到群聊</DialogTitle>
        <div className="message-share-content">
          <pre className="message-share-preview">{text}</pre>
          <p className="text-muted-foreground">群里的伙伴可以读取这条消息。</p>
          {shares?.map((share) => <div className="message-share-row" key={share.id}>
            <span>{groups.find((group) => group.id === share.destinationConversationId)?.title ?? "群聊"}</span>
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void revoke(share.id)}>停止共享</Button>
          </div>)}
          {!!shares?.length && <p className="text-muted-foreground">停止共享不会撤回已经使用的内容。</p>}
          {available.length > 0 && <NativeSelect aria-label="目标群聊" value={destination}
            disabled={saving || Boolean(request.current)} onChange={(event) => setDestination(event.target.value)}>
            <NativeSelectOption value="">选择群聊</NativeSelectOption>
            {available.map((group) => <NativeSelectOption key={group.id} value={group.id}>{group.title}</NativeSelectOption>)}
          </NativeSelect>}
          {!shares && !error && <p role="status">正在读取共享记录…</p>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button disabled={saving || !destination || !shares} onClick={() => void share()}>
          {saving ? "正在处理…" : request.current ? "重试共享" : "共享"}
        </Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
