import { HighlightedText } from "./HighlightedText";
import { fileSizeParts } from "@livingbot/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@livingbot/ui-web";
import { Copy, Download, ExternalLink, FileText, FolderOpen, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { errorText } from "../lib/user-error";

export function DeliveryFileCard({
  name,
  nameHighlight,
  wrapName,
  size,
  status,
  error: externalError,
  disabled,
  onOpen,
  onReveal,
  onCopy,
  onDownload,
}: {
  name: string;
  nameHighlight?: string;
  wrapName?: boolean;
  size?: number;
  status?: string;
  error?: string;
  disabled?: boolean;
  onOpen(): Promise<void>;
  onReveal?: () => Promise<void>;
  onCopy?: () => Promise<void>;
  onDownload?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const parts = size === undefined ? null : fileSizeParts(size);
  const bytes = parts ? `${parts.amount} ${parts.unit}` : status;
  return (
    <div
      className="min-w-0 rounded-2xl border border-border/60 bg-muted/60 p-3"
      data-testid="delivery-file-card"
    >
      <div className="flex min-w-0 items-center gap-3">
        <FileText aria-hidden="true" className="size-8 shrink-0 text-primary" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left disabled:opacity-60"
          disabled={disabled || busy}
          onClick={() => void run(onOpen)}
          title={name}
        >
          <span className={`block text-sm font-medium ${wrapName ? "line-clamp-2 break-words" : "truncate"}`}><HighlightedText text={name} query={nameHighlight ?? ""} /></span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {busy ? "处理中…" : bytes}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled || busy}
                aria-label={`${name} 的操作`}
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52 whitespace-nowrap">
            {onReveal ? <DropdownMenuItem onClick={() => void run(onReveal)}>
              <FolderOpen />
              打开源文件夹
            </DropdownMenuItem> : null}
            <DropdownMenuItem onClick={() => void run(onOpen)}>
              <ExternalLink />
              在默认应用打开
            </DropdownMenuItem>
            {onCopy ? (
              <DropdownMenuItem onClick={() => void run(onCopy)}>
                <Copy />
                复制路径
              </DropdownMenuItem>
            ) : null}
            {onDownload ? (
              <DropdownMenuItem onClick={() => void run(onDownload)}>
                <Download />
                下载
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error || externalError ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error || externalError}
        </p>
      ) : null}
    </div>
  );
}
