import { Trans, useLingui } from "@lingui/react/macro";
import type { ScratchpadItem } from "@livingbot/contracts";
import { fetchFresh, writeSaved } from "@livingbot/core/query";
import { Button, Checkbox, Disclosure, Input, SectionHeading } from "@livingbot/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";

const NO_ITEMS: ScratchpadItem[] = [];

export function ScratchpadSection({ botId, active = true }: { botId: string; active?: boolean }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.scratchpad.list.queryOptions({ input: { botId } });
  // The bot edits its open work as it runs, so every open refreshes behind the cached list.
  const query = useQuery({
    ...list,
    enabled: active,
    refetchOnMount: "always",
    refetchInterval: active ? 15_000 : false,
  });
  const items = query.data ?? NO_ITEMS;
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setItems(update: (current: ScratchpadItem[]) => ScratchpadItem[]) {
    return writeSaved(queryClient, list.queryKey, (current) => update(current ?? []));
  }

  async function refresh() {
    await fetchFresh(queryClient, list);
  }

  async function addItem() {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.scratchpad.create({ botId, title });
      setDraft("");
      setAdding(false);
      await setItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not add`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(item: ScratchpadItem, status: ScratchpadItem["status"]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.scratchpad.update({ itemId: item.id, status });
      await setItems((current) => {
        const next = current.map((entry) => (entry.id === updated.id ? updated : entry));
        return status === "done" ? next.filter((entry) => entry.status !== "done") : next;
      });
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: ScratchpadItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.remove({ itemId: item.id });
      await setItems((current) => current.filter((entry) => entry.id !== item.id));
      try {
        await refresh();
      } catch {
        setError(t`Removed, but list refresh failed`);
      }
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="bot-scratchpad">
      <SectionHeading className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Trans>To-do list</Trans>
          {query.data ? (
            <span className="font-normal tabular-nums text-label text-muted-foreground">
              {items.length}
            </span>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="xs"
          aria-label={adding ? t`Hide new to-do` : t`Add to-do`}
          title={adding ? t`Hide new to-do` : t`Add to-do`}
          aria-expanded={adding}
          disabled={busy}
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? <X className="size-4" /> : <Plus className="size-4" />}
          {adding ? <Trans>Show less</Trans> : <Trans>Add</Trans>}
        </Button>
      </SectionHeading>
      {query.isPending ? (
        <p role="status" className="py-4 text-body2 text-muted-foreground">
          <Trans>Loading tasks…</Trans>
        </p>
      ) : null}
      {query.isError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 py-2 text-body2 text-destructive"
        >
          <Trans>Could not load tasks</Trans>
          <Button variant="ghost" size="xs" onClick={() => void query.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {!query.isPending && !query.isError && !items.length && !adding ? (
        <p className="py-4 text-body2 text-muted-foreground">
          <Trans>No to-dos yet</Trans>
        </p>
      ) : null}
      {(showAll ? items : items.slice(0, 5)).map((item) => (
        // Same row rhythm as the routine list above: one target, hover bleeding past the text.
        <div
          key={item.id}
          className="group -mx-2 flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60 motion-reduce:transition-none"
        >
          <Checkbox
            aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
            checked={item.status === "done"}
            disabled={busy}
            onCheckedChange={(checked) => void setStatus(item, checked ? "done" : "open")}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1">
            <div
              className={`break-words text-start text-body2 ${
                item.status === "done" ? "text-muted-foreground/80 line-through" : "text-foreground"
              }`}
              dir="auto"
            >
              {item.title}
            </div>
            {item.notes ? (
              <Disclosure
                summary={<Trans>Details</Trans>}
                className="mt-0.5 text-label text-muted-foreground"
                summaryClassName="min-h-6 hover:text-foreground"
                contentClassName="pt-1"
              >
                <div className="whitespace-pre-wrap break-words" dir="auto">
                  {item.notes}
                </div>
              </Disclosure>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t`Remove`}
            disabled={busy}
            onClick={() => void removeItem(item)}
            className="-my-0.5 size-5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
          >
            <X size={12} />
          </Button>
        </div>
      ))}
      {items.length > 5 ? (
        <Button
          variant="ghost"
          size="xs"
          className="w-full justify-start ps-6 text-muted-foreground"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
        </Button>
      ) : null}
      {adding ? (
        <form
          className="flex flex-wrap items-center gap-2 pt-2"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              setDraft("");
              setAdding(false);
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void addItem();
          }}
        >
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t`Add item`}
            aria-label={t`New to-do`}
            maxLength={200}
            className="min-w-32 flex-1"
          />
          <Button type="submit" variant="secondary" disabled={busy || !draft.trim()}>
            <Trans>Add</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft("");
              setAdding(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </form>
      ) : null}
      {error ? (
        <div role="alert" className="mt-2 text-caption text-destructive">
          {error}
        </div>
      ) : null}
    </section>
  );
}
