import type { ThreadMessage } from "@livingbot/contracts";
import { Button } from "@livingbot/ui-web";
import { useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { ArtifactFileCard } from "./ArtifactFileCard";

export function MessageDeliveryFiles({
  message,
  target,
}: {
  message: ThreadMessage;
  target: ArtifactTarget;
}) {
  const [expanded, setExpanded] = useState(false);
  const files = message.blocks.filter((b) => b.kind === "file");
  const entries = files.map((file) => ({
    key: file.artifactId,
    node: <ArtifactFileCard compact {...file} target={target} />,
  }));
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
