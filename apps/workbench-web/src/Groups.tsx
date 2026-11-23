import { useState } from "react";
import { ArrowUpRight, Plus, UsersRound } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Checkbox } from "@livingbot/ui-web/components/ui/checkbox";
import { Input } from "@livingbot/ui-web/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@livingbot/ui-web/components/ui/dialog";
import type { Bot, Conversation } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchClient } from "./client.ts";

export function Groups({ client, bots, conversations, onOpen, onCreated }: {
  client: WorkbenchClient; bots: Bot[]; conversations: Conversation[];
  onOpen: (conversation: Conversation) => void;
  onCreated: (conversation: Conversation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  async function create() {
    if (saving || !members.length || !title.trim()) return;
    setSaving(true); setError(undefined);
    try {
      const conversation = await client.request<Conversation>("/api/conversations", {
        kind: "group", botIds: members, title: title.trim(),
      });
      setOpen(false); setTitle(""); setMembers([]); onCreated(conversation);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  return <section className="catalog-page">
    <div className="group-heading"><h1>群聊</h1><Button onClick={() => setOpen(true)}><Plus />新建群聊</Button></div>
    {conversations.filter((item) => item.kind === "group").map((item) => <button className="task-row" key={item.id} onClick={() => onOpen(item)}>
      <UsersRound size={20} /><span className="task-row-title">{item.title}<small>{item.botIds.map((id) => bots.find((bot) => bot.id === id)?.name).join("、")}</small></span><ArrowUpRight size={16} />
    </button>)}
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <DialogContent>
        <DialogTitle>新建群聊</DialogTitle>
        <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <Input aria-label="群聊名称" placeholder="群聊名称" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} disabled={saving} />
          <fieldset className="group-members"><legend>伙伴</legend>
            {bots.map((bot) => <label key={bot.id}><Checkbox checked={members.includes(bot.id)} disabled={saving}
              onCheckedChange={(checked) => setMembers((current) => checked ? [...current, bot.id] : current.filter((id) => id !== bot.id))} />{bot.name}</label>)}
          </fieldset>
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <DialogFooter><Button type="submit" disabled={saving || !title.trim() || !members.length}>{saving ? "创建中" : "创建"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
