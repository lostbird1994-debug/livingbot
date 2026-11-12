import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { AgentSkill, AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import { isDeletableMemoryDocument, isEmptyBotMemory } from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { Badge, Button, SectionHeading, Skeleton, Textarea } from "@rakazo/ui-web";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web/components/ui/tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AvailabilityControl,
  AvailabilityLabel,
  reachesOtherSpaces,
  useOwnSpaces,
} from "../components/integrations/space-availability";
import { SettingsSectionHeading } from "../components/SettingsSectionHeading";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";

const NO_DOCS: MemoryDocument[] = [];

/** One stored version of a memory document; restoring one writes it again as the newest. */
type MemoryRevisionRow = { revision: number; chars: number; createdAt: string };
const NO_SKILLS: AgentSkillCatalogEntry[] = [];

const fieldClass = "mt-2 w-full font-mono text-[13px] leading-relaxed";

function rowClass(open: boolean): string {
  return `h-auto w-full justify-start whitespace-normal px-2.5 py-2.5 text-start ${open ? "bg-muted" : ""}`;
}

/**
 * Bot memory. Skills belong to the person in a space, not to one bot, so they live in
 * the Skills dialog; memory shared across bots lives in the Memory settings overlay.
 */
export function KnowledgeSection({ botId, excludePaths }: { botId: string; excludePaths?: string[] }) {
  return (
    <MemoryDocumentList
      key={botId}
      input={{ botId, scope: "bot" }}
      testId="bot-knowledge-memory"
      excludePaths={excludePaths}
      compact
    />
  );
}

/** Edit the complete stored source, never the truncated prompt excerpt. */
export function LoadedMemoryEditor({
  botId,
  scope,
  path,
}: {
  botId: string;
  scope: "bot" | "user";
  path: string;
}) {
  return (
    <MemoryDocumentList
      input={scope === "bot" ? { botId, scope } : { scope }}
      testId={`loaded-memory-editor-${scope}-${path}`}
      pathFilter={path}
    />
  );
}

/** The space's shared memory documents, mounted in the Memory settings overlay. */
export function SpaceMemorySection() {
  return (
    <section
      className="rounded-xl border border-border px-4 py-4"
      data-testid="space-memory-documents"
    >
      <SettingsSectionHeading className="mb-0">
        <Trans>Workspace-shared memory</Trans>
      </SettingsSectionHeading>
      <p className="mt-1 text-[13px] text-muted-foreground">
        <Trans>
          Shared by your bots in this workspace. Summaries load automatically; other notes are read
          on demand.
        </Trans>
      </p>
      <div className="mt-3">
        <MemoryDocumentList input={{ scope: "user" }} testId="space-memory-list" />
      </div>
    </section>
  );
}

function MemoryDocumentList({
  input,
  testId,
  compact = false,
  pathFilter,
  excludePaths,
}: {
  input: { botId?: string; scope: "bot" | "user" };
  testId: string;
  compact?: boolean;
  pathFilter?: string;
  excludePaths?: string[];
}) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.memory.list.queryOptions({ input });
  // Bots write memory as they run, so every open refreshes behind the cached list.
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  const docs = (listQuery.data ?? NO_DOCS).filter(doc => !excludePaths?.includes(doc.path));
  const loading = listQuery.isPending;
  const [showAll, setShowAll] = useState(false);
  // Once shown, memory stays visible while the panel is open, even if emptied.
  const [memoryShown, setMemoryShown] = useState(false);
  const memoryVisible = memoryShown || docs.some((doc) => !isEmptyBotMemory(doc));
  if (memoryVisible && !memoryShown) setMemoryShown(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<number | undefined>();
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? (listQuery.isError ? t`Could not load` : null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [history, setHistory] = useState<MemoryRevisionRow[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [preview, setPreview] = useState<{ revision: number; content: string } | null>(null);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current += 1;
    },
    [],
  );

  function setDocs(update: (current: MemoryDocument[]) => MemoryDocument[]) {
    return writeSaved(queryClient, list.queryKey, (current) => update(current ?? []));
  }

  function openDoc(doc: MemoryDocument) {
    selection.current += 1;
    setLoadedRevision(doc.revision);
    setConflicted(false);
    setOpenId(doc.id);
    setDraft(doc.content);
    setError(null);
    setConfirmingDelete(false);
    setHistory(null);
    setHistoryBusy(false);
    setPreview(null);
  }

  function closeDoc() {
    selection.current += 1;
    setOpenId(null);
    setConflicted(false);
    setConfirmingDelete(false);
    setHistory(null);
    setHistoryBusy(false);
    setPreview(null);
  }

  async function loadHistory(doc: MemoryDocument) {
    if (historyBusy) return;
    if (history) {
      setHistory(null);
      setPreview(null);
      return;
    }
    setHistoryBusy(true);
    setError(null);
    const current = selection.current;
    try {
      const rows = await rpc.memory.revisions({ documentId: doc.id });
      if (current === selection.current) setHistory(rows);
    } catch {
      if (current === selection.current) setError(t`Could not load versions`);
    } finally {
      if (current === selection.current) setHistoryBusy(false);
    }
  }

  async function previewVersion(doc: MemoryDocument, revision: number) {
    if (historyBusy || busy) return;
    const current = selection.current;
    setHistoryBusy(true);
    setError(null);
    try {
      const version = await rpc.memory.revision({ documentId: doc.id, revision });
      if (current === selection.current) setPreview(version);
    } catch {
      if (current === selection.current) setError(t`Could not load versions`);
    } finally {
      if (current === selection.current) setHistoryBusy(false);
    }
  }

  async function restore(doc: MemoryDocument, revision: number) {
    if (busy || conflicted) return;
    setBusy(true);
    setError(null);
    try {
      const restored = await rpc.memory.restore({
        documentId: doc.id,
        revision,
        expectedRevision: loadedRevision ?? doc.revision,
      });
      await setDocs((current) =>
        current.map((entry) => (entry.id === restored.id ? restored : entry)),
      );
      // Show the restored text, not the draft it replaced.
      setDraft(restored.content);
      setLoadedRevision(restored.revision);
      setConflicted(false);
      setPreview(null);
      try {
        setHistory(await rpc.memory.revisions({ documentId: doc.id }));
      } catch {
        setHistory(null);
        setError(t`Could not load versions`);
      }
    } catch (err) {
      if (err instanceof ORPCError && err.code === "CONFLICT") {
        setConflicted(true);
        try {
          await fetchFresh(queryClient, list);
        } catch {
          /* Preserve conflict and draft. */
        }
      } else {
        setError(t`Could not restore that version`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(doc: MemoryDocument) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.memory.remove({ documentId: doc.id });
      await setDocs((current) => current.filter((entry) => entry.id !== doc.id));
      closeDoc();
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  async function save(doc: MemoryDocument) {
    if (busy || conflicted) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.memory.update({
        documentId: doc.id,
        content: draft,
        expectedRevision: loadedRevision,
      });
      await setDocs((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      closeDoc();
    } catch (err) {
      if (err instanceof ORPCError && err.code === "CONFLICT") {
        setConflicted(true);
        try {
          await fetchFresh(queryClient, list);
        } catch {
          // Keep the draft and conflict state even if refreshing fails.
        }
      } else {
        setError(t`Could not save`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function downloadDocument(doc: MemoryDocument) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const latest = (await fetchFresh(queryClient, list)).find((entry) => entry.id === doc.id);
      if (!latest) throw new Error("Document unavailable");
      downloadArtifactBytes(
        latest.path.split("/").at(-1) ?? latest.path,
        "text/markdown",
        new TextEncoder().encode(latest.content),
      );
    } catch {
      setError(t`Could not load`);
    } finally {
      setBusy(false);
    }
  }

  if (compact && !memoryVisible && !error) return null;
  return (
    <section className={compact ? "mt-6" : undefined}>
      {compact ? (
        <SectionHeading variant="label" className="mb-2">
          <Trans>Memory</Trans>
        </SectionHeading>
      ) : null}
      <div data-testid={testId} className={compact ? "rounded-xl bg-muted/50 p-4" : undefined}>
        {error ? <div className="pb-2 text-[13px] text-destructive">{error}</div> : null}
        {conflicted ? (
          <div className="pb-2 text-[13px] text-destructive">
            <Trans>Document changed. Reopen to edit the latest version.</Trans>
          </div>
        ) : null}
        {loading ? <Skeleton className="h-10 w-full" /> : null}
        {compact && !loading && docs.length > 0 ? (
          <div className="pb-2 text-[12px] leading-relaxed text-muted-foreground">
            <Trans>
              MEMORY.md loads on every run. Other documents are listed in the prompt and read only
              when the bot needs them.
            </Trans>
          </div>
        ) : null}
        {!compact && !loading && docs.length === 0 && !error ? (
          <div className="py-1 text-[13px] text-muted-foreground">
            <Trans>Nothing remembered yet</Trans>
          </div>
        ) : null}
        <div>
          {(pathFilter
            ? docs.filter((doc) => doc.path === pathFilter)
            : compact && !showAll
              ? docs.slice(0, 5)
              : docs
          ).map((doc) => (
            <div key={doc.id} className="border-b border-border last:border-0">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => (openId === doc.id ? closeDoc() : openDoc(doc))}
                  className="-ms-2 h-auto min-w-0 flex-1 justify-start whitespace-normal px-2 py-2.5 text-start"
                >
                  <span
                    className="min-w-0 truncate text-[14px] font-normal text-foreground"
                    dir="auto"
                  >
                    {pathFilter ? <Trans>Edit full document</Trans> : doc.path}
                  </span>
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost" size="icon-sm" />}
                    aria-label={t`Download`}
                    disabled={busy}
                    onClick={() => downloadDocument(doc)}
                  >
                    <Download className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <Trans>Download</Trans>
                  </TooltipContent>
                </Tooltip>
              </div>
              {openId === doc.id ? (
                <div className="pb-2">
                  <Textarea
                    aria-label={doc.path}
                    disabled={busy}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
                    className={fieldClass}
                    dir="auto"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={busy || conflicted || draft === doc.content}
                      onClick={() => void save(doc)}
                    >
                      <Trans>Save</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busy}
                      onClick={closeDoc}
                      size="sm"
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busy || historyBusy}
                      onClick={() => void loadHistory(doc)}
                      size="sm"
                    >
                      {history ? <Trans>Hide versions</Trans> : <Trans>Versions</Trans>}
                    </Button>
                    {isDeletableMemoryDocument(doc.path) ? (
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(doc)}
                        size="sm"
                        className="ml-auto text-destructive"
                      >
                        {confirmingDelete ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
                      </Button>
                    ) : null}
                  </div>
                  {history ? (
                    <div className="mt-2 rounded-lg border border-border">
                      {history.length === 0 ? (
                        <div className="px-3 py-2 text-[12px] text-muted-foreground">
                          <Trans>No earlier versions</Trans>
                        </div>
                      ) : (
                        history.map((row) => (
                          <div
                            key={row.revision}
                            className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-0"
                          >
                            <span className="font-mono text-[12px] text-muted-foreground">
                              v{row.revision}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                              {row.chars.toLocaleString()} chars ·{" "}
                              {new Date(row.createdAt).toLocaleString()}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              disabled={busy || historyBusy}
                              onClick={() => void previewVersion(doc, row.revision)}
                            >
                              <Trans>Preview</Trans>
                            </Button>
                            {row.revision === doc.revision ? (
                              <span className="text-[12px] text-muted-foreground">
                                <Trans>Current</Trans>
                              </span>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                type="button"
                                disabled={busy || historyBusy || conflicted}
                                onClick={() => void restore(doc, row.revision)}
                              >
                                <Trans>Restore</Trans>
                              </Button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                  {preview ? (
                    <Textarea
                      aria-label={`${doc.path} v${preview.revision}`}
                      readOnly
                      value={preview.content}
                      rows={8}
                      className={fieldClass}
                      dir="auto"
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {compact && docs.length > 5 && !showAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SkillSourceBadge({ source }: { source: AgentSkillCatalogEntry["source"] }) {
  if (source !== "builtin" && source !== "plugin") return null;
  return (
    <Badge
      variant="secondary"
      className="rounded-full px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
    >
      {source === "builtin" ? <Trans>Built-in</Trans> : <Trans>Plugin</Trans>}
    </Badge>
  );
}

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

/** Your own skills in this space, plus the built-in ones; plugin skills are listed by plugin. */
export function AgentSkills() {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  // The same list the composer offers as skill mentions, so a change here shows there at once.
  const list = queries.agentSkills.list.queryOptions();
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  const skills = (listQuery.data ?? NO_SKILLS).filter((skill) => skill.source !== "plugin");
  const loading = listQuery.isPending;
  const [open, setOpen] = useState<AgentSkill | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? (listQuery.isError ? t`Could not load` : null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const selection = useRef(0);
  const spaceCount = useOwnSpaces().length;

  async function refresh() {
    return fetchFresh(queryClient, list);
  }

  useEffect(
    () => () => {
      selection.current += 1;
    },
    [],
  );

  async function openSkill(entry: AgentSkillCatalogEntry) {
    if (busy) return;
    const current = ++selection.current;
    setCreating(false);
    setConfirmingDelete(false);
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      // A slower response must not clobber a newer selection or a fresh draft.
      if (current !== selection.current) return;
      setOpen(skill);
      setDraft(skill.content);
    } catch {
      if (current !== selection.current) return;
      setError(t`Could not load skill`);
    }
  }

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await rpc.agentSkills.create({ content: draft });
      } else if (open) {
        await rpc.agentSkills.update({ skillId: open.id, content: draft });
      }
      setOpen(null);
      setCreating(false);
      setConfirmingDelete(false);
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not save skill`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: AgentSkill) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    const skillId = skill.id;
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.remove({ skillId });
      if (open?.id === skillId) {
        setOpen(null);
        setConfirmingDelete(false);
      }
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not delete skill`);
    } finally {
      setBusy(false);
    }
  }

  const editorOpen = creating || open;
  return (
    <div data-testid="bot-knowledge-skills">
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {loading ? <Skeleton className="h-10 w-full" /> : null}
      {!loading && skills.length === 0 && !editorOpen && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground">
          <Trans>No skills yet</Trans>
        </div>
      ) : null}
      {!editorOpen
        ? skills.map((entry) => (
            <Button
              variant="ghost"
              key={entry.id}
              type="button"
              disabled={busy}
              onClick={() => void openSkill(entry)}
              className={`${rowClass(false)} -mx-2.5 w-[calc(100%+1.25rem)] block`}
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span
                  className="min-w-0 truncate text-[14px] font-normal text-foreground"
                  dir="auto"
                >
                  {entry.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <AvailabilityLabel availability={entry.availability} />
                  <SkillSourceBadge source={entry.source} />
                </span>
              </span>
              <span
                className="mt-0.5 block truncate text-[12.5px] text-muted-foreground"
                dir="auto"
              >
                {entry.description}
              </span>
            </Button>
          ))
        : null}
      {editorOpen ? (
        <div className="pb-2">
          {open ? (
            <div className="flex min-h-7 items-center gap-2">
              <div className="min-w-0 truncate text-[14px] font-normal text-foreground" dir="auto">
                {open.name}
              </div>
              <SkillSourceBadge source={open.source} />
              {open.source === "user" ? (
                <div className="ms-auto">
                  <AvailabilityControl
                    kind="skill"
                    id={open.id}
                    availability={open.availability}
                    onChanged={async () => {
                      // Another skill may have been opened while this was saving; leave it alone.
                      const opened = selection.current;
                      // Narrowed away from this space, the skill can no longer be read here.
                      const here = (await refresh()).some((entry) => entry.id === open.id);
                      if (selection.current !== opened) return;
                      if (!here) {
                        selection.current += 1;
                        setOpen(null);
                        return;
                      }
                      const fresh = await rpc.agentSkills.get({ skillId: open.id });
                      if (selection.current === opened) setOpen(fresh);
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <Textarea
            aria-label="SKILL.md"
            disabled={busy}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(20, Math.max(8, draft.split("\n").length + 1))}
            readOnly={Boolean(open?.readOnly)}
            className={fieldClass}
            dir="auto"
          />
          <div className="mt-2 flex items-center gap-2">
            {!open?.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy || !draft.trim() || (!creating && draft === open?.content)}
                onClick={() => void save()}
                className="bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
              >
                <Trans>Save</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                selection.current += 1;
                setOpen(null);
                setCreating(false);
                setConfirmingDelete(false);
              }}
              className="px-3 py-1.5 text-[13px] text-muted-foreground"
            >
              {open?.readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
            </Button>
            {open && !open.readOnly ? (
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => void remove(open)}
                className={`ms-auto px-3 py-1.5 text-[13px] ${
                  confirmingDelete ? "bg-destructive/10 text-destructive" : "text-destructive"
                }`}
              >
                {confirmingDelete ? (
                  reachesOtherSpaces(open.availability, spaceCount) ? (
                    <Trans>Remove from every space?</Trans>
                  ) : (
                    <Trans>Confirm delete</Trans>
                  )
                ) : (
                  <Trans>Delete</Trans>
                )}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            selection.current += 1;
            setOpen(null);
            setCreating(true);
            setConfirmingDelete(false);
            setDraft(NEW_SKILL_TEMPLATE);
            setError(null);
          }}
          className="-mx-2.5 mt-2 h-auto min-h-11 w-[calc(100%+1.25rem)] justify-between px-2.5 py-2.5 text-sm font-normal text-foreground"
        >
          <Trans>New skill</Trans>
          <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
}
