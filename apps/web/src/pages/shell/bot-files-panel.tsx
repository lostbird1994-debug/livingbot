import { useLingui } from "@lingui/react/macro";
import { Button, Spinner } from "@livingbot/ui-web";
import { ChevronRight, FileText, Folder, FolderOpen, RotateCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

type Entry = { path: string; kind: "file" | "dir"; size: number };

/**
 * The API treats "/" as the team root, so a bot's own folder is addressed as `bots/<id>`.
 * Everything below is shown relative to that, which is why the prefix is stripped for display
 * and put back for every request.
 */
function rootOf(botId: string): string {
  return `bots/${botId}`;
}

function parentOf(root: string, path: string): string | null {
  if (path === root) return null;
  const parts = path
    .slice(root.length + 1)
    .split("/")
    .filter(Boolean);
  parts.pop();
  return parts.length ? `${root}/${parts.join("/")}` : root;
}

/** "bots/<id>/deliverables/x.md" -> "deliverables/x.md" */
function relativeTo(root: string, path: string): string {
  return path === root ? "" : path.slice(root.length + 1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Folders first, then by name, so the list reads the same way every time. */
function sorted(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path, undefined, { numeric: true });
  });
}

/**
 * The bot's own folder on this Mac: `data/homes/<home>/bots/<id>`. Shell and files both run
 * here, so this is where its deliverables, notes and scratch work end up. Names open in the
 * app that owns them rather than in a preview, which is what the folder is for.
 */
export function BotFilesPanel({ botId }: { botId: string }) {
  return <BotDirectory key={botId} botId={botId} />;
}

function BotDirectory({ botId }: { botId: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const root = rootOf(botId);
  const [path, setPath] = useState(root);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const listing = useQuery(queries.computer.files.queryOptions({ input: { botId, path } }));
  const entries = sorted(listing.data ?? []);

  async function act(entry: Entry, action: "open" | "reveal") {
    if (busy) return;
    setBusy(entry.path);
    setError("");
    try {
      await rpc.computer.fileAction({ botId, path: entry.path, action });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  const parent = parentOf(root, path);
  const current = relativeTo(root, path);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!parent}
          onClick={() => setPath(parent ?? root)}
        >
          {t`Up`}
        </Button>
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
          {current || t`Bot folder`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={t`Refresh`}
          onClick={() => void listing.refetch()}
        >
          <RotateCw className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/70 bg-card shadow-xs">
        {listing.isPending ? (
          <div className="grid h-24 place-items-center">
            <Spinner aria-label={t`Loading files…`} />
          </div>
        ) : listing.isError && !listing.data ? (
          <p className="px-3 py-4 text-xs text-destructive">{errorText(listing.error)}</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">{t`No files yet.`}</p>
        ) : (
          <ul className="divide-y divide-border/50 p-1.5">
            {entries.map((entry) => (
              <li
                key={entry.path}
                className="group flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/60 motion-reduce:transition-none"
              >
                {entry.kind === "dir" ? (
                  <button
                    type="button"
                    onClick={() => setPath(entry.path)}
                    className="flex min-h-8 min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {entry.path.split("/").at(-1)}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-faint-foreground" />
                  </button>
                ) : (
                  <>
                    <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      disabled={busy === entry.path}
                      title={entry.path}
                      onClick={() => void act(entry, "open")}
                      className="min-h-8 min-w-0 flex-1 truncate rounded-md text-left text-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
                    >
                      {entry.path.split("/").at(-1)}
                    </button>
                    <span className="shrink-0 text-[11px] tabular-nums text-faint-foreground">
                      {formatSize(entry.size)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="bot-file-reveal"
                      aria-label={t`Show in Finder`}
                      title={t`Show in Finder`}
                      disabled={busy === entry.path}
                      onClick={() => void act(entry, "reveal")}
                    >
                      <FolderOpen className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error || (listing.isError && listing.data) ? (
        <p className="text-xs text-destructive">{error || errorText(listing.error)}</p>
      ) : null}
    </div>
  );
}
