import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function LocalMessageFileLink({
  path,
  label,
  messageId,
  target,
  inline = false,
}: {
  path: string;
  label?: string;
  messageId: string;
  target: ArtifactTarget;
  inline?: boolean;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "open" | "reveal") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await rpc.threads.fileAction({ ...target, messageId, path, action });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 align-baseline">
      <a
        href={`file://${path}`}
        title={path}
        className="break-all text-link underline underline-offset-2"
        aria-disabled={busy}
        onClick={(event) => {
          event.preventDefault();
          void act("open");
        }}
        onAuxClick={(event) => event.preventDefault()}
      >
        {label || path.split("/").at(-1) || path}
      </a>
      {!inline ? <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={busy}
        title={t`Open containing folder`}
        onClick={() => void act("reveal")}
      >
        <FolderOpen className="size-3.5" />
        {t`Open folder`}
      </Button> : null}
      {error ? (
        <span role="alert" className="w-full text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
