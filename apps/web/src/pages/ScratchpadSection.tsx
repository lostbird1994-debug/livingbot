import { Trans, useLingui } from "@lingui/react/macro";
import type { ScratchpadItem } from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { Button, Checkbox, Disclosure, Input, SectionHeading } from "@rakazo/ui-web";
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
      <SectionHeading className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Trans>To-do list</Trans>
          {query.data ? (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
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
      <div className="overflow-hidden rounded-xl border border-border/60 bg-background p-2">
        {query.isPending ? (
          <p role="status" className="px-3 py-5 text-sm text-muted-foreground">
            <Trans>Loading tasks…</Trans>
          </p>
        ) : null}
        {query.isError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 px-3 py-3 text-sm text-destructive"
          >
            <Trans>Could not load tasks</Trans>
            <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        {!query.isPending && !query.isError && !items.length && !adding ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            <Trans>No to-dos yet</Trans>
          </div>
        ) : null}
        {(showAll ? items : items.slice(0, 5)).map((item) => (
          <div
            key={item.id}
            className="group flex items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/60 motion-reduce:transition-none"
          >
            <Checkbox
              aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
              checked={item.status === "done"}
              disabled={busy}
              onCheckedChange={(checked) => void setStatus(item, checked ? "done" : "open")}
              className="mt-[3px]"
            />
            <div className="min-w-0 flex-1">
              <div
                className={`break-words text-start text-sm leading-relaxed ${item.status === "done" ? "text-muted-foreground/80 line-through" : "text-foreground"}`}
                dir="auto"
              >
                {item.title}
              </div>
              {item.notes ? (
                <Disclosure
                  summary={<Trans>Details</Trans>}
                  className="mt-1.5 text-xs text-muted-foreground"
                  summaryClassName="min-h-7 hover:text-foreground"
                  contentClassName="pt-1.5"
                >
                  <div className="whitespace-pre-wrap break-words leading-relaxed" dir="auto">
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
              className="-mt-0.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <X />
            </Button>
          </div>
        ))}
        {items.length > 5 ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full text-muted-foreground"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
          </Button>
        ) : null}
        {adding ? (
          <form
            className="flex flex-wrap items-center gap-2 p-2"
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
      </div>
      {error ? (
        <div role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </section>
  );
}
