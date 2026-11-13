import { Trans, useLingui } from "@lingui/react/macro";
import type { RoutineRunCursor } from "@livingbot/contracts";
import { formatCron } from "@livingbot/core";
import {
  Button,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Spinner,
  Switch,
  Textarea,
} from "@livingbot/ui-web";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { cronLabels } from "../lib/cron";
import { connectedModelOptions, modelOptionKey, parseModelOptionKey } from "../lib/model-catalog";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { statusLabel } from "./ActivityList";

export function MemoryOrganizationSettings() {
  const { t, i18n } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const cache = useQueryClient();
  const id = useId();
  const organizers = useQuery(queries.memory.organizers.queryOptions({}));
  const credentials = useQuery(queries.models.credentials.queryOptions({}));
  const catalog = useQuery(queries.models.list.queryOptions({}));
  const [selected, setSelected] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = organizers.data?.routines ?? [];
  const row =
    rows.find((item) => item.routine.id === selected) ??
    rows.find((item) => item.shared) ??
    rows[0];
  const routine = row?.routine;
  useEffect(() => {
    setModelKey(
      routine?.modelProvider && routine.modelId
        ? modelOptionKey(routine.modelProvider, routine.modelId)
        : "",
    );
    setActive(routine?.active ?? false);
  }, [routine?.id, routine?.modelProvider, routine?.modelId, routine?.active]);
  const options = connectedModelOptions(credentials.data ?? [], catalog.data ?? []);
  const refresh = () => cache.invalidateQueries({ queryKey: queries.memory.organizers.key() });
  const owner = useMutation({
    mutationFn: (routineId: string) => rpc.memory.setSharedOrganizer({ routineId }),
    onSuccess: async (_, routineId) => {
      setSelected(routineId);
      await refresh();
    },
    onError: (err) => setError(errorText(err, t`Could not save memory organization settings`)),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!routine) return;
      const model = modelKey ? parseModelOptionKey(modelKey) : null;
      await rpc.routines.update({
        routineId: routine.id,
        active,
        modelProvider: model?.provider ?? null,
        modelId: model?.modelId ?? null,
      });
    },
    onSuccess: refresh,
    onError: (err) => setError(errorText(err, t`Could not save memory organization settings`)),
  });
  const busy = owner.isPending || save.isPending;
  const savedModel =
    routine?.modelProvider && routine.modelId
      ? modelOptionKey(routine.modelProvider, routine.modelId)
      : "";
  return (
    <section className="space-y-4 text-sm" data-testid="memory-organization-settings">
      <SectionHeading>
        <Trans>Automatic memory organization</Trans>
      </SectionHeading>
      {organizers.isPending ? (
        <Spinner aria-label={t`Loading…`} />
      ) : organizers.isError ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not load memory organization settings</Trans>
          <Button variant="text" onClick={() => void organizers.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No memory organizer configured</Trans>
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-owner`} className="block text-muted-foreground">
            <Trans>Shared memory organizer</Trans>
            <NativeSelect
              id={`${id}-owner`}
              className="mt-2 w-full"
              value={organizers.data?.sharedRoutineId ?? ""}
              disabled={busy}
              onChange={(event) => {
                setError(null);
                owner.mutate(event.target.value);
              }}
            >
              {!rows.some((item) => item.shared) ? (
                <NativeSelectOption value="">{t`Choose an organizer`}</NativeSelectOption>
              ) : null}
              {rows.map((item) => (
                <NativeSelectOption
                  key={item.routine.id}
                  value={item.routine.id}
                  disabled={!item.canOrganize}
                >
                  {item.botName}
                  {!item.routine.active ? t` (paused)` : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <details className="rounded-lg border border-border p-4" open>
            <summary className="cursor-pointer font-medium">
              <Trans>Organizer settings</Trans>
            </summary>
            <div className="mt-4 space-y-4">
              <label htmlFor={`${id}-bot`} className="block text-muted-foreground">
                <Trans>View organizer</Trans>
                <NativeSelect
                  id={`${id}-bot`}
                  className="mt-2 w-full"
                  value={routine?.id}
                  disabled={busy}
                  onChange={(event) => {
                    setError(null);
                    setSelected(event.target.value);
                  }}
                >
                  {rows.map((item) => (
                    <NativeSelectOption key={item.routine.id} value={item.routine.id}>
                      {item.botName}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label htmlFor={`${id}-model`} className="block text-muted-foreground">
                <Trans>Execution model</Trans>
                <NativeSelect
                  id={`${id}-model`}
                  className="mt-2 w-full"
                  value={modelKey}
                  disabled={busy || credentials.isPending || catalog.isPending}
                  onChange={(event) => {
                    setError(null);
                    setModelKey(event.target.value);
                  }}
                >
                  <NativeSelectOption value="">
                    {t`Bot's model`}
                    {row?.botModelId ? ` · ${row.botModelId}` : ""}
                  </NativeSelectOption>
                  {modelKey && !options.some((option) => option.key === modelKey) ? (
                    <NativeSelectOption value={modelKey}>
                      {parseModelOptionKey(modelKey)?.modelId ?? modelKey}
                    </NativeSelectOption>
                  ) : null}
                  {options.map((option) => (
                    <NativeSelectOption key={option.key} value={option.key}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              {credentials.isError || catalog.isError ? (
                <p role="alert" className="text-destructive">
                  <Trans>Could not load available models</Trans>
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-4">
                <label htmlFor={`${id}-active`}>
                  <Trans>Enable automatic organization</Trans>
                </label>
                <Switch
                  id={`${id}-active`}
                  checked={active}
                  disabled={busy || !row?.canOrganize}
                  onCheckedChange={setActive}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Daily check, or earlier after 30 messages or a large summary. At least 6 hours
                  between checks.
                </Trans>
                {routine
                  ? ` ${routine.crons
                      .map((cron) => formatCron(cron, cronLabels(i18n.locale)))
                      .join(", ")} · ${routine.timezone}`
                  : ""}
              </p>
              <Button
                disabled={busy || (modelKey === savedModel && active === routine?.active)}
                onClick={() => {
                  setError(null);
                  save.mutate();
                }}
              >
                {save.isPending ? <Spinner aria-label={t`Saving…`} /> : <Trans>Save</Trans>}
              </Button>
              <details>
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Organization instructions</Trans>
                </summary>
                <Textarea
                  className="mt-3 min-h-64 text-xs"
                  readOnly
                  value={routine?.prompt ?? ""}
                  aria-label={t`Organization instructions`}
                />
              </details>
              {routine ? <OrganizationDiary key={routine.id} routineId={routine.id} /> : null}
            </div>
          </details>
        </>
      )}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function OrganizationDiary({ routineId }: { routineId: string }) {
  const { i18n, t } = useLingui();
  const queries = useSpaceQueries();
  const [open, setOpen] = useState(false);
  const diary = useInfiniteQuery(
    queries.memory.organizationDiary.infiniteOptions({
      input: (before: RoutineRunCursor | null) => ({ routineId, ...(before ? { before } : {}) }),
      initialPageParam: null as RoutineRunCursor | null,
      getNextPageParam: (page) => page.nextCursor,
      enabled: open,
      refetchInterval: open ? 15_000 : false,
    }),
  );
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-muted-foreground">
        <Trans>Organization diary</Trans>
      </summary>
      {diary.isError ? (
        <p role="alert" className="mt-3 text-destructive">
          <Trans>Could not load organization diary</Trans>
        </p>
      ) : diary.isPending && open ? (
        <Spinner aria-label={t`Loading…`} />
      ) : null}
      {diary.data?.pages[0]?.runs.length === 0 ? (
        <p className="mt-3 text-muted-foreground">
          <Trans>No organization runs yet</Trans>
        </p>
      ) : null}
      <ul className="mt-3 divide-y divide-border">
        {diary.data?.pages
          .flatMap((page) => page.runs)
          .map((run) => (
            <li key={run.id} className="space-y-2 py-3 text-xs">
              <div className="flex flex-wrap justify-between gap-2">
                <time dateTime={run.createdAt}>
                  {new Date(run.createdAt).toLocaleString(i18n.locale)}
                </time>
                <span>{statusLabel(run.status)}</span>
              </div>
              {run.modelId ? <p className="text-muted-foreground">{run.modelId}</p> : null}
              {run.unchanged ? (
                <p>
                  <Trans>No changes; model was not called</Trans>
                </p>
              ) : run.status === "completed" && run.changes.length === 0 ? (
                <p>
                  <Trans>Review completed; no documents changed</Trans>
                </p>
              ) : null}
              {run.error ? <p className="break-words text-destructive">{run.error}</p> : null}
              {run.changes.map((change, index) => (
                <div key={`${change.path}-${index}`} className="break-words">
                  <p className={change.status === "failed" ? "text-destructive" : ""}>
                    {change.path} ·{" "}
                    {change.status === "applied"
                      ? t`Saved ${change.savedCharacters ?? 0} characters`
                      : t`Failed`}
                  </p>
                  {change.status === "applied" ? (
                    <p className="text-muted-foreground">
                      v{change.sourceRevision} → v{change.revision}
                      <br />
                      {t`Full original archive`}: {change.archive}
                    </p>
                  ) : (
                    <p className="text-destructive">{change.error}</p>
                  )}
                </div>
              ))}
            </li>
          ))}
      </ul>
      {diary.hasNextPage ? (
        <Button
          variant="text"
          disabled={diary.isFetchingNextPage}
          onClick={() => void diary.fetchNextPage()}
        >
          <Trans>Load older runs</Trans>
        </Button>
      ) : null}
    </details>
  );
}
