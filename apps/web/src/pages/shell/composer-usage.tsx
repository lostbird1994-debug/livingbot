import { Trans, useLingui } from "@lingui/react/macro";
import type { ConversationUsage } from "@rakazo/contracts";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@rakazo/ui-web";
import { Activity, Database, Gauge } from "lucide-react";

export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / (value < 1_000_000 ? 1000 : 1_000_000)).toFixed(1)}${value < 1_000_000 ? "K" : "M"}`;
}

export function ComposerUsage({
  usage,
  failed,
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
  return (
    <div className="pointer-events-auto flex justify-center bg-background px-4 pb-2 pt-1">
      <Popover>
        <PopoverTrigger
          className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={t`Conversation usage details`}
        >
          {failed ? (
            <span>
              <Trans>Usage unavailable</Trans>
            </span>
          ) : !usage ? (
            <span>
              <Trans>Loading usage…</Trans>
            </span>
          ) : (
            <>
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
              <span>
                <Trans>Cache hit</Trans>{" "}
                {rate !== null && rate !== undefined ? `${Math.round(rate * 100)}%` : "—"}
              </span>
              <span className="inline-flex items-center gap-1">
                <Gauge className="size-3" aria-hidden />
                {speed !== null && speed !== undefined ? `${speed.toFixed(1)} tok/s` : "— tok/s"}
              </span>
              <span className="inline-flex items-center gap-1">
                <Database className="size-3" aria-hidden />
                <Trans>Conversation</Trans>{" "}
                {usage.total.tokens !== null
                  ? tokens(usage.total.tokens)
                  : usage.total.reportedCalls > 0
                    ? t`At least ${compactTokens(usage.total.knownTokens)} tok`
                    : unavailable}
              </span>
              {context ? (
                <span>
                  <Trans>Context ≈</Trans> {Math.round((context.tokens / context.window) * 100)}%
                </span>
              ) : null}
            </>
          )}
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
              <Trans>Latest model time</Trans>
            </dt>
            <dd>
              {latest?.modelDurationMs !== null && latest?.modelDurationMs !== undefined
                ? `${(latest.modelDurationMs / 1000).toFixed(1)} s`
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
    </div>
  );
}
