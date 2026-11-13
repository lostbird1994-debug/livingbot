import type { ThreadMessage } from "@livingbot/contracts";
import { localDocumentReferences } from "@livingbot/core";
import { Button } from "@livingbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { ArtifactFileCard } from "./ArtifactFileCard";
import { DeliveryFileCard } from "./DeliveryFileCard";

export function messageFileReferences(blocks: ThreadMessage["blocks"]) {
  return [
    ...new Set(
      blocks.flatMap((b) =>
        b.kind === "text" ? localDocumentReferences(b.text).map((r) => r.path) : [],
      ),
    ),
  ];
}
export function MessageDeliveryFiles({
  message,
  target,
}: {
  message: ThreadMessage;
  target: ArtifactTarget;
}) {
  const [expanded, setExpanded] = useState(false);
  const files = message.blocks.filter((b) => b.kind === "file");
  const paths = files.length ? [] : messageFileReferences(message.blocks);
  const entries = [
    ...files.map((file) => ({
      key: file.artifactId,
      node: <ArtifactFileCard compact {...file} target={target} />,
    })),
    ...paths.map((path) => ({
      key: path,
      node: <LocalDeliveryFile path={path} messageId={message.id} target={target} />,
    })),
  ];
  if (!entries.length) return null;
  return (
    <section
      className="mt-4 max-w-full space-y-2"
      aria-label="文件"
      data-testid="message-delivery-files"
    >
      <div
        className={`grid min-w-0 gap-2 ${entries.length > 1 ? "sm:grid-cols-2" : "max-w-md grid-cols-1"}`}
      >
        {(expanded ? entries : entries.slice(0, 2)).map((item) => (
          <div className="min-w-0" key={item.key}>
            {item.node}
          </div>
        ))}
      </div>
      {entries.length > 2 ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起文件" : `查看全部文件（${entries.length}）`}
        </Button>
      ) : null}
    </section>
  );
}
function LocalDeliveryFile({
  path,
  messageId,
  target,
}: {
  path: string;
  messageId: string;
  target: ArtifactTarget;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const info = useQuery({
    enabled: visible,
    queryKey: ["message-file-info", target, messageId, path],
    queryFn: () => rpc.threads.fileInfo({ ...target, messageId, path }),
    staleTime: 60000,
    retry: false,
  });
  return (
    <div ref={ref}>
      <DeliveryFileCard
        name={info.data?.name ?? path.split("/").at(-1) ?? path}
        size={info.data?.size}
        status={info.isPending ? "正在定位文件…" : "文件不可用"}
        disabled={!info.data}
        error={info.isError ? errorText(info.error) : undefined}
        onOpen={async () => {
          await rpc.threads.fileAction({ ...target, messageId, path, action: "open" });
        }}
        onReveal={async () => {
          await rpc.threads.fileAction({ ...target, messageId, path, action: "reveal" });
        }}
        onCopy={
          info.data
            ? async () => {
                await navigator.clipboard.writeText(info.data.path);
              }
            : undefined
        }
      />
    </div>
  );
}
