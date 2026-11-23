import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { SpaceQueries } from "../../lib/query";
import type { RpcClient } from "../../lib/rpc";

/**
 * Reuse the 1.0 scoped query cache for private, group and task conversations.
 * Never borrow the previous conversation's usage as placeholder data.
 */
export function useConversationUsage({
  queries,
  target,
  enabled,
  running,
  revision,
}: {
  queries: SpaceQueries;
  target: Parameters<RpcClient["usage"]["thread"]>[0];
  enabled: boolean;
  running: boolean;
  revision?: string;
}) {
  const query = useQuery({
    ...queries.usage.thread.queryOptions({ input: target }),
    enabled,
    refetchInterval: running ? 5_000 : 30_000,
  });
  const previous = useRef({ running, revision });
  useEffect(() => {
    const changed = previous.current.running !== running || previous.current.revision !== revision;
    previous.current = { running, revision };
    if (enabled && changed) void query.refetch();
  }, [enabled, running, revision, query.refetch]);
  return query;
}
