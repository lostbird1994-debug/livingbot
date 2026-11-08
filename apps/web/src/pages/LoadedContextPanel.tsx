import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, SectionHeading, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { BotRoleCardEditor } from "./BotRoleCardEditor";
import { KnowledgeSection, LoadedMemoryEditor } from "./KnowledgeSection";

const characters = (text: string) => Array.from(text).length;
const textClass =
  "mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed";

function Content({
  title,
  detail,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="rounded-xl border border-border/70 bg-card px-4 py-3 shadow-xs">
      <summary className="cursor-pointer text-sm font-medium leading-relaxed text-foreground">
        {title}
        {detail ? <span className="ml-2 text-xs text-muted-foreground">{detail}</span> : null}
      </summary>
      {children}
    </details>
  );
}

/** Current private-chat inputs, with exact memory excerpts supplied by the executor's renderer. */
export function LoadedContextPanel({
  botId,
  active = true,
  bot,
  publicProfile,
  spaceName,
}: {
  botId: string;
  active?: boolean;
  bot?: Bot;
  publicProfile?: ReactNode;
  spaceName?: string;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const query = useQuery({
    ...queries.memory.loadedContext.queryOptions({ input: { botId } }),
    refetchOnMount: "always",
    refetchInterval: active ? 15_000 : false,
    enabled: active,
  });
  const data = query.data;
  if (!data && query.isPending) return <Spinner aria-label={t`Loading context…`} />;
  if (!data && query.isError)
    return (
      <div role="alert" className="space-y-3">
        <p className="text-sm text-destructive">{errorText(query.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  if (!data) return null;
  const loaded = data.memory.documents.filter((doc) => doc.shownChars > 0);
  const onDemand = data.memory.documents.filter((doc) => doc.shownChars < doc.totalChars);
  const shared = loaded
    .filter((doc) => doc.scope === "user")
    .reduce((sum, doc) => sum + doc.shownChars, 0);
  return (
    <div className="space-y-6" data-testid="loaded-context-panel">
      <div>
        <div className="flex items-center justify-between gap-2">
          <SectionHeading>
            <Trans>Automatic inputs</Trans>
          </SectionHeading>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={query.isFetching}
            aria-label={t`Refresh loaded context`}
            onClick={() => void query.refetch()}
          >
            <RotateCw className="size-4" />
          </Button>
        </div>
        <p
          className="mt-1 text-xs leading-relaxed text-muted-foreground"
          title={t`Current preview for a private chat. Not a record of a past model request.`}
        >
          <Trans>Preview for the current private-chat settings</Trans>
        </p>
        {query.isError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            <Trans>Refresh failed. Showing the previous preview.</Trans>
          </p>
        ) : null}
      </div>
      {bot ? (
        <BotRoleCardEditor
          bot={bot}
          publicProfile={publicProfile}
          onSaved={() => {
            void query.refetch();
          }}
        />
      ) : null}
      <div className="space-y-2">
        <div>
          <SectionHeading variant="label">
            <Trans>Automatically loaded memory</Trans>
          </SectionHeading>
          <p className="my-2 text-xs leading-relaxed text-muted-foreground">
            <Trans>
              Memory block: {characters(data.memory.body)} / {data.budgets.body} characters.
              Workspace-shared source text: {shared} characters.
            </Trans>
          </p>
          <div className="space-y-2">
            {(["bot", "user"] as const).map((scope) => (
              <section key={scope} className="space-y-2 pt-2">
                <SectionHeading variant="label">
                  {scope === "bot" ? (
                    <Trans>Bot private memory</Trans>
                  ) : (
                    <Trans>Workspace-shared memory</Trans>
                  )}
                </SectionHeading>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {scope === "bot"
                    ? (bot?.name ?? t`This bot only`)
                    : spaceName
                      ? t`Workspace “${spaceName}” · shared by your bots`
                      : t`Current workspace · shared by your bots`}
                </p>
                {scope === "user" && data.sharedProfileExcluded ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <Trans>
                      Not loaded: workspace-shared USER.md, MEMORY.md and profile.md. This bot has
                      its own user identity or backstory enabled.
                    </Trans>
                  </p>
                ) : null}
                {loaded
                  .filter((doc) => doc.scope === scope)
                  .map((doc) => (
                    <Content
                      key={`${doc.scope}:${doc.path}`}
                      title={<span className="break-all">{doc.path}</span>}
                      detail={
                        doc.shownChars < doc.totalChars ? (
                          <Trans>Partial</Trans>
                        ) : (
                          <Trans>Full</Trans>
                        )
                      }
                    >
                      <p className="mt-2 text-xs text-muted-foreground">
                        v{doc.revision} ·{" "}
                        <Trans>
                          {doc.shownChars} / {doc.totalChars} source characters loaded
                        </Trans>
                      </p>
                      <pre className={textClass}>{doc.excerpt}</pre>
                      {scope === "user" ? (
                        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                          <Trans>
                            Edits affect your bots using this document in this workspace.
                          </Trans>
                        </p>
                      ) : null}
                      <LoadedMemoryEditor botId={botId} scope={doc.scope} path={doc.path} />
                    </Content>
                  ))}
                {!loaded.some((doc) => doc.scope === scope) &&
                !(scope === "user" && data.sharedProfileExcluded) ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>No memory text is automatically loaded.</Trans>
                  </p>
                ) : null}
              </section>
            ))}
          </div>
        </div>
        {data.memory.index ? (
          <Content
            title={<Trans>Memory files read on demand</Trans>}
            detail={t`${onDemand.length} documents`}
          >
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              <Trans>
                This directory is loaded automatically; the listed documents are not loaded in full.
              </Trans>
            </p>
            <pre className={textClass}>{data.memory.index.trim()}</pre>
          </Content>
        ) : null}
        <Content
          title={<Trans>Open work</Trans>}
          detail={data.scratchpad ? t`${characters(data.scratchpad)} characters` : t`None`}
        >
          {data.scratchpad ? (
            <pre className={textClass}>{data.scratchpad}</pre>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>No open work is currently included.</Trans>
            </p>
          )}
        </Content>
      </div>
      <Content title={<Trans>View assembled inputs</Trans>}>
        <div className="mt-3 space-y-2">
          <Content
            title={<Trans>Assembled identity and instructions</Trans>}
            detail={t`${characters(data.identity)} characters`}
          >
            <pre className={textClass}>{data.identity}</pre>
          </Content>
          <Content title={<Trans>Exact assembled memory block</Trans>}>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              <Trans>
                Includes source headings and truncation notices. Directory entries have a separate
                budget.
              </Trans>
            </p>
            <pre className={textClass}>{data.memory.context || t`No memory context`}</pre>
          </Content>
          <Content title={<Trans>Other inputs depend on the conversation</Trans>}>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              <Trans>
                Rakazo also adds built-in behavior and safety rules, available tools, skills and
                environment information. Recent messages, attachments, group context and retrieved
                content depend on the task and model window. Working files such as README.md and
                TOOLS.md are not automatically included just because they exist. External messaging
                channels use different loading rules.
              </Trans>
            </p>
          </Content>
        </div>
      </Content>
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-sm">
          <Trans>View and edit all private memory</Trans>
        </summary>
        <div className="mt-3">
          <KnowledgeSection botId={botId} />
        </div>
      </details>
    </div>
  );
}
