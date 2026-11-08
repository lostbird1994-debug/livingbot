import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

/**
 * Whether a setting is the target's own copy or comes from the level above it, shown beside the
 * setting so no page has to be read twice to learn which one it edits.
 */
export function InheritanceBadge({
  own,
  ownLabel,
  inheritedLabel,
}: {
  own: boolean;
  ownLabel?: ReactNode;
  inheritedLabel?: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <span
      data-testid="inheritance-badge"
      data-own={own ? "true" : "false"}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] leading-5 ${
        own
          ? "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border text-muted-foreground"
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${own ? "bg-amber-600 dark:bg-amber-400" : "bg-muted-foreground/50"}`}
      />
      {own ? (ownLabel ?? t`Set here`) : (inheritedLabel ?? t`Inherited`)}
    </span>
  );
}
