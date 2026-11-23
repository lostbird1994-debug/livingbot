import type { TaskSession } from "@livingbot/contracts";
import type { ComponentProps } from "react";
import { Activity, useRef } from "react";
import { TaskConversation } from "./task-conversation";

/** Preserve open editors while React pauses subscriptions in inactive tabs. */
export function TaskConversationPanels({
  opened,
  sessions,
  draftTitleFor,
  ...props
}: ComponentProps<typeof TaskConversation> & {
  opened: readonly string[];
  sessions: readonly TaskSession[];
  draftTitleFor: (key: string) => string | undefined;
}) {
  const keys = opened.includes(props.tabKey) ? opened : [...opened, props.tabKey];
  const find = useRef({ last: props.findRequest, requests: new Map<string, number>() });
  if (find.current.last !== props.findRequest) {
    find.current.last = props.findRequest;
    find.current.requests.set(props.tabKey, props.findRequest);
  }
  return keys.map((key) => (
    <Activity key={key} mode={props.tabKey === key ? "visible" : "hidden"}>
      <TaskConversation
        {...props}
        tabKey={key}
        session={sessions.find((session) => session.id === key)}
        draftTitle={draftTitleFor(key)}
        findRequest={find.current.requests.get(key) ?? 0}
      />
    </Activity>
  ));
}
