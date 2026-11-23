import { Trans, useLingui } from "@lingui/react/macro";
import type { ConversationUsage } from "@livingbot/contracts";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@livingbot/ui-web";
import { Activity, Database, Gauge } from "lucide-react";

export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / (value < 1_000_000 ? 1000 : 1_000_000)).toFixed(1)}${value < 1_000_000 ? "K" : "M"}`;
}

export function ComposerUsage({
  usage,
}: {
  usage: ConversationUsage | undefined;
  failed?: boolean;
}) {
  const { t } = useLingui();
  const unavailable = t`Not reported`;
  const tokens = (value: number | null | undefined) =>
    value === null || value === undefined ? unavailable : `${compactTokens(value)} tok`;
  const latest = usage?.latest;
  const rate = latest?.cacheHitRate;
  const speed = latest?.tokensPerSecond;
  const context = usage?.context;
  const hasLatest = Boolean(latest && (latest.tokens !== null || latest.reportedCalls > 0));
  const hasTotal = Boolean(usage && (usage.total.tokens !== null || usage.total.reportedCalls > 0));
  // Keep the footer's space during an initial read; cached data remains useful
  // even when a background refresh fails.
  const visible = Boolean(
    usage && (hasLatest || hasTotal || rate != null || speed != null || context),
  );
  return (
    <div className="pointer-events-auto flex min-h-8 justify-center bg-background px-4 pb-2 pt-1">
      {visible && usage ? (
        <Popover>
          <PopoverTrigger
            className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t`Conversation usage details`}
          >
            {hasLatest ? (
              <span className="inline-flex items-center gap-1">
                <Activity className="size-3" aria-hidden />
                <Trans>Latest</Trans>{" "}
                {latest && latest.calls > 0
                  ? latest.tokens !== null
                    ? tokens(latest.tokens)
                    : latest.reportedCalls > 0
                      ? t`At least ${compactTokens(latest.knownTokens)} tok`
                      : unavailable
                  : "—"}
              </span>
            ) : null}
            {rate != null ? (
              <span>
                <Trans>Cache hit</Trans> {Math.round(rate * 100)}%
              </span>
            ) : null}
            {speed != null ? (
              <span className="inline-flex items-center gap-1">
                <Gauge className="size-3" aria-hidden />
                {speed.toFixed(1)} tok/s
              </span>
            ) : null}
            {hasTotal ? (
              <span className="inline-flex items-center gap-1">
                <Database className="size-3" aria-hidden />
                <Trans>Conversation</Trans>{" "}
                {usage.total.tokens !== null
                  ? tokens(usage.total.tokens)
                  : usage.total.reportedCalls > 0
                    ? t`At least ${compactTokens(usage.total.knownTokens)} tok`
                    : unavailable}
              </span>
            ) : null}
            {context ? (
              <span>
                <Trans>Context ≈</Trans> {Math.round((context.tokens / context.window) * 100)}%
              </span>
            ) : null}
          </PopoverTrigger>
          <PopoverContent side="top" className="w-80 p-4">
            <PopoverTitle>
              <Trans>Conversation usage</Trans>
            </PopoverTitle>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs tabular-nums">
              <dt>
                <Trans>Latest model calls</Trans>
              </dt>
              <dd>{latest?.calls ?? "—"}</dd>
              <dt>
                <Trans>Latest input (including cache)</Trans>
              </dt>
              <dd>{tokens(latest?.inputTokens)}</dd>
              <dt>
                <Trans>Latest output (including reasoning)</Trans>
              </dt>
              <dd>{tokens(latest?.outputTokens)}</dd>
              <dt>
                <Trans>Latest cache read</Trans>
              </dt>
              <dd>{tokens(latest?.cacheReadTokens)}</dd>
              <dt>
                <Trans>模型请求耗时</Trans>
              </dt>
              <dd>
                {latest?.modelRequestDurationMs !== null && latest?.modelRequestDurationMs !== undefined
                  ? `${(latest.modelRequestDurationMs / 1000).toFixed(1)} s`
                  : unavailable}
              </dd>
              <dt>
                <Trans>Reported calls / all calls</Trans>
              </dt>
              <dd>{usage ? `${usage.total.reportedCalls} / ${usage.total.calls}` : "—"}</dd>
              {context ? (
                <>
                  <dt>
                    <Trans>Estimated context / window</Trans>
                  </dt>
                  <dd>
                    {compactTokens(context.tokens)} / {compactTokens(context.window)}
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="text-xs leading-relaxed text-muted-foreground">
              <Trans>
                Includes model calls during tool use and subagents. Speed excludes tool and approval
                waits. Missing provider data stays unknown. Context is the last prepared input
                estimate.
              </Trans>
            </p>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
