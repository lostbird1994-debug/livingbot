import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Snapshot } from "../../../../packages/workbench/src/contracts";
import { ConnectionSettings } from "../../../workbench-web/src/ConnectionSettings";
import { WorkbenchClient } from "../../../workbench-web/src/client";
import { MemoryCenter } from "../../../workbench-web/src/MemoryCenter";
import { MigrationCenter } from "../../../workbench-web/src/MigrationCenter";
import { localConnection } from "../lib/local-workbench";
import "./local-knowledge-settings.css";

/** Reuse the existing native-service views inside the selected product shell. */
export function LocalKnowledgeSettings({
  botId,
  view = "memory",
  onBusyChange,
}: {
  botId?: string;
  view?: "memory" | "data" | "connections";
  onBusyChange?: (busy: boolean) => void;
}) {
  const navigate = useNavigate();
  const [connection, setConnection] = useState<{ origin: string; token: string }>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState("");
  const client = useMemo(
    () => connection && new WorkbenchClient(connection.origin, connection.token),
    [connection],
  );
  useEffect(() => {
    let active = true;
    void localConnection()
      .then((value) => {
        if (!value) throw new Error("本机服务未连接");
        if (active) setConnection(value);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!client || view !== "memory") return;
    let active = true;
    void client
      .request<Snapshot>("/api/snapshot")
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [client, view]);
  return (
    <div className="local-knowledge space-y-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {view === "memory" && client && snapshot && (
        <MemoryCenter
          client={client}
          bots={snapshot.bots.filter((bot) => !bot.archivedAt && (!botId || bot.id === botId))}
          conversations={snapshot.conversations}
          initialBotId={botId}
          onBusyChange={onBusyChange}
        />
      )}
      {client && view === "data" && (
        <MigrationCenter
          client={client}
          onBusyChange={onBusyChange}
          onOpen={(bot) => navigate(`/app/${bot.id}`)}
        />
      )}
      {client && view === "connections" && (
        <ConnectionSettings
          client={client}
          embedded
          onBusyChange={onBusyChange}
          onChanged={() => undefined}
        />
      )}
    </div>
  );
}
