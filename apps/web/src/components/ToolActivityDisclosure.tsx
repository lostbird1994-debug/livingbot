import { Plural, Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@livingbot/chat-ui/web";
import type { ThreadMessage } from "@livingbot/contracts";
import { formatCompactDuration } from "@livingbot/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@livingbot/ui-web/components/ui/collapsible";
import {
  ChevronRight,
  FileText,
  Globe,
  MousePointerClick,
  PenLine,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { groupActivityBlocks, needsTimeline } from "../lib/activity-timeline";
import { commandAction, commandTarget } from "../lib/command-action";
import { toolStepCount } from "../lib/tool-activity-view";
import { shortDetail, type ToolFamily, toolFamily } from "../lib/tool-step-visual";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];

/** The initial window in an expanded, lengthy execution history. */
export const LIVE_TOOL_STEP_WINDOW = 12;

const FAMILY_ICON = {
  read: FileText,
  write: PenLine,
  search: Search,
  run: Terminal,
  browse: Globe,
  control: MousePointerClick,
  tool: Wrench,
} as const;

/** What a shell command was trying to do, said the way a person would. */
const COMMAND_ACTIONS: Record<string, ReactNode> = {
  "review-changes": <Trans>Reviewing changes</Trans>,
  "review-history": <Trans>Reviewing history</Trans>,
  "list-files": <Trans>Listing files</Trans>,
  "read-file": <Trans>Reading a file</Trans>,
  "search-content": <Trans>Searching the files</Trans>,
  "run-tests": <Trans>Running tests</Trans>,
  build: <Trans>Building</Trans>,
  install: <Trans>Installing dependencies</Trans>,
  "call-endpoint": <Trans>Calling an endpoint</Trans>,
  "run-script": <Trans>Running a script</Trans>,
  "organize-files": <Trans>Moving files</Trans>,
  "check-environment": <Trans>Checking the environment</Trans>,
  "change-directory": <Trans>Changing directory</Trans>,
};

/** A tool that names no target still says what it did, in the reader's language. */
const TOOL_LABELS: Record<string, ReactNode> = {
  process: <Trans>Waiting on a command</Trans>,
  read: <Trans>Reading a file</Trans>,
  ls: <Trans>Listing files</Trans>,
  grep: <Trans>Searching the files</Trans>,
  write: <Trans>Writing a file</Trans>,
  edit: <Trans>Editing a file</Trans>,
  apply_patch: <Trans>Editing files</Trans>,
  memory_search: <Trans>Searching memory</Trans>,
  memory_get: <Trans>Reading memory</Trans>,
  web_search: <Trans>Searching the web</Trans>,
  web_fetch: <Trans>Reading a page</Trans>,
};

/** The verb a row leads with; the target it acted on follows it. */
const FAMILY_VERB: Record<ToolFamily, ReactNode> = {
  read: <Trans>Read</Trans>,
  write: <Trans>Wrote</Trans>,
  search: <Trans>Searched</Trans>,
  run: <Trans>Ran</Trans>,
  browse: <Trans>Browsed</Trans>,
  control: <Trans>Used</Trans>,
  tool: <Trans>Called</Trans>,
};

export function ToolSteps({
  steps,
  currentIndex,
  limit,
}: {
  steps: readonly ToolStep[];
  currentIndex?: number;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
}) {
  const [earlier, setEarlier] = useState(0);
  const hidden = limit === undefined ? 0 : Math.max(0, steps.length - limit - earlier);
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <button
          type="button"
          className="rounded-sm text-[13px] leading-7 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          data-testid="tool-rows-hidden"
          onClick={() => setEarlier(earlier + (limit ?? hidden))}
        >
          <Plural value={hidden} one="Show # earlier step" other="Show # earlier steps" />
        </button>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        const running = index === currentIndex;
        const family = toolFamily(step.tool);
        const Icon = FAMILY_ICON[family];
        // A shell command is named by what it does; the command itself stays on the row's title.
        const action = family === "run" ? commandAction(step.detail) : undefined;
        const actionTarget = action ? commandTarget(step.detail) : undefined;
        return (
          <Fragment key={index}>
            {step.note ? (
              <div className="pb-1 pt-2" data-testid="tool-step-note">
                <ChatMarkdown>{step.note}</ChatMarkdown>
              </div>
            ) : null}
            <Collapsible
              className="min-w-0"
              data-testid="tool-step"
              data-running={running || undefined}
            >
              <CollapsibleTrigger
                disabled={!step.detail}
                className="flex w-full min-w-0 items-center gap-2 rounded-sm text-start leading-5 outline-none enabled:cursor-pointer enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon
                  aria-hidden
                  size={14}
                  strokeWidth={1.6}
                  className="shrink-0 text-muted-foreground"
                />
                <span
                  className={`flex min-w-0 flex-1 items-center gap-2 text-[15px] leading-7 ${
                    running ? "text-foreground" : "text-muted-foreground"
                  }`}
                  title={step.detail ? `${step.label}: ${step.detail}` : step.label}
                >
                  <span className="min-w-0 truncate">
                    {step.action ? (
                      step.action
                    ) : action ? (
                      <>
                        {COMMAND_ACTIONS[action]}
                        {actionTarget ? (
                          <span className="text-muted-foreground/70"> {actionTarget}</span>
                        ) : null}
                      </>
                    ) : step.detail ? (
                      <>
                        <span className="text-muted-foreground/70">{FAMILY_VERB[family]} </span>
                        {shortDetail(step.detail)}
                      </>
                    ) : (
                      (TOOL_LABELS[step.tool ?? ""] ?? step.label)
                    )}
                    {step.count > 1 ? ` ×${step.count}` : ""}
                  </span>
                  {running ? (
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full bg-warning motion-safe:animate-pulse"
                    />
                  ) : null}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="my-2 ms-5 whitespace-pre-wrap break-all border-s border-border ps-3 text-[12px] leading-5 text-muted-foreground">
                  {step.detail}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * One status line for the entire process. Manual toggles survive updates within a phase.
 */
export function ToolActivityDisclosure({
  live,
  toolCount,
  durationMs,
  children,
}: {
  live: boolean;
  toolCount: number;
  durationMs?: number;
  children: ReactNode;
}) {
  const duration = formatCompactDuration(durationMs);
  // Open while the run works, so the person can watch; folded away once it ends, so a finished
  // chat stays readable.
  const [open, setOpen] = useState(live);
  // A finished run folds itself away even if this card was already mounted while it worked.
  useEffect(() => setOpen(live), [live]);
  return (
    <Collapsible
      key={live ? "working" : "actions"}
      open={open}
      onOpenChange={setOpen}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <CollapsibleTrigger className="flex min-h-7 w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 pe-1.5 text-[15px] text-muted-foreground outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        {live ? (
          <span className="flex items-center gap-2">
            <span>
              <Trans>Working…</Trans>
            </span>
            <span>
              {toolCount > 0 ? <Plural value={toolCount} one="# tool" other="# tools" /> : null}
            </span>
          </span>
        ) : duration ? (
          <span>
            <Trans>Completed {duration}</Trans>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <span>{toolCount > 0 ? <Trans>Done</Trans> : <Trans>Completed</Trans>}</span>
            <span>
              {toolCount > 0 ? <Plural value={toolCount} one="# tool" other="# tools" /> : null}
            </span>
          </span>
        )}
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          style={open ? { transform: "rotate(90deg)" } : undefined}
          className="transition-transform duration-150 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div className="mt-2 min-w-0" data-testid="tool-activity-body">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ReasoningActivity({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastScrollTop = useRef(0);
  useEffect(() => setOpen(live), [live]);
  useEffect(() => {
    const element = body.current;
    if (live && open && follow.current && element) {
      element.scrollTop = element.scrollHeight;
      lastScrollTop.current = element.scrollTop;
    }
  }, [text, live, open]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="reasoning-activity">
      <CollapsibleTrigger className="flex min-h-7 cursor-pointer items-center gap-1 rounded-md text-[15px] leading-7 text-muted-foreground outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring">
        <span className={live ? "motion-safe:animate-pulse" : undefined}>
          <Trans>Deep thought</Trans>
        </span>
        <ChevronRight
          aria-hidden
          size={13}
          strokeWidth={1.8}
          style={open ? { transform: "rotate(90deg)" } : undefined}
          className="transition-transform duration-150 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div
          ref={body}
          data-testid="reasoning-content"
          className="mt-2 max-h-[200px] overflow-y-auto overscroll-contain border-s-4 border-border ps-3 pe-2 text-[13px] leading-5 text-muted-foreground [overflow-anchor:none] [&_.rk-chat-markdown]:leading-5"
          onScroll={(event) => {
            const element = event.currentTarget;
            const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
            if (element.scrollTop < lastScrollTop.current && remaining > 20) follow.current = false;
            else if (remaining < 10) follow.current = true;
            lastScrollTop.current = element.scrollTop;
          }}
        >
          <ChatMarkdown streaming={live}>{text}</ChatMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Consecutive operations share a short action-and-target summary until opened. */
function ToolOperationGroup({ steps, live }: { steps: readonly ToolStep[]; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  if (steps.length < 2)
    return (
      <ToolSteps
        steps={steps}
        currentIndex={live ? steps.length - 1 : undefined}
        limit={LIVE_TOOL_STEP_WINDOW}
      />
    );
  const representatives: ToolStep[] = [];
  const families = new Set<ToolFamily>();
  for (const step of steps) {
    const family = toolFamily(step.tool);
    if (families.has(family)) continue;
    families.add(family);
    representatives.push(step);
    if (representatives.length === 2) break;
  }
  const Icon = FAMILY_ICON[toolFamily(steps[0]?.tool)];
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="tool-operation-group">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-sm text-start text-[15px] leading-7 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <Icon aria-hidden size={14} strokeWidth={1.6} className="shrink-0" />
        <span className="min-w-0 truncate">
          {representatives.map((step, index) => {
            const action = toolFamily(step.tool) === "run" ? commandAction(step.detail) : undefined;
            return (
              <Fragment key={index}>
                {index > 0 ? " · " : ""}
                {step.action ??
                  (action ? (
                    COMMAND_ACTIONS[action]
                  ) : (
                    <>
                      {FAMILY_VERB[toolFamily(step.tool)]}
                      {step.detail ? ` ${shortDetail(step.detail)}` : ` ${step.label}`}
                    </>
                  ))}
              </Fragment>
            );
          })}
        </span>
        <ChevronRight
          aria-hidden
          size={13}
          strokeWidth={1.8}
          style={open ? { transform: "rotate(90deg)" } : undefined}
          className="shrink-0"
        />
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div className="mt-1 ps-5">
          <ToolSteps
            steps={steps}
            currentIndex={live ? steps.length - 1 : undefined}
            limit={LIVE_TOOL_STEP_WINDOW}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Everything one run did behind a single fold: a finished run reads as one line, and opening it
 * shows the thoughts and the tool groups in the order they happened.
 */
export function ActivityTimeline({
  blocks,
  live,
  renderText,
  activeBlock = blocks.at(-1),
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
  renderText?: (
    block: Extract<ThreadMessage["blocks"][number], { kind: "text" | "progress" }>,
  ) => ReactNode;
  activeBlock?: ThreadMessage["blocks"][number];
}) {
  const stepBlocks = blocks.filter(
    (block): block is Extract<ThreadMessage["blocks"][number], { kind: "steps" }> =>
      block.kind === "steps",
  );
  const toolCount = stepBlocks.reduce((sum, block) => sum + toolStepCount(block.steps), 0);
  // The clock lands on whichever group finished last; an earlier one still speaks for the run.
  const durationMs = stepBlocks.findLast((block) => block.durationMs !== undefined)?.durationMs;
  const last = activeBlock;
  return (
    <div className="flex justify-start" dir="ltr" data-testid="activity-timeline">
      <div className="w-full min-w-0 ps-1">
        <ToolActivityDisclosure live={live} toolCount={toolCount} durationMs={durationMs}>
          <div className="space-y-4">
            {blocks.map((block, index) => {
              if (block.kind === "reasoning") {
                return (
                  <ReasoningActivity key={index} text={block.text} live={live && block === last} />
                );
              }
              if (block.kind === "text" || block.kind === "progress")
                return (
                  <div key={index}>
                    {renderText ? (
                      renderText(block)
                    ) : (
                      <ChatMarkdown streaming={live && block.kind === "progress" && block === last}>
                        {block.text}
                      </ChatMarkdown>
                    )}
                  </div>
                );
              if (block.kind !== "steps") return null;
              return (
                <ToolOperationGroup key={index} steps={block.steps} live={live && block === last} />
              );
            })}
          </div>
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/**
 * A tools-only message: a plain muted line between messages, not a chat bubble.
 */
export function StandaloneToolActivity({
  live,
  steps,
  toolCount,
  durationMs,
}: {
  live: boolean;
  steps: readonly ToolStep[];
  toolCount: number;
  durationMs?: number;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="w-full min-w-0 ps-1">
        <ToolActivityDisclosure live={live} toolCount={toolCount} durationMs={durationMs}>
          <ToolSteps
            steps={steps}
            currentIndex={live ? steps.length - 1 : undefined}
            limit={live ? LIVE_TOOL_STEP_WINDOW : undefined}
          />
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/** A bot message whose only visible blocks are tool cards: one slim line per card, no bubble. */
export function ToolOnlyNarration({
  blocks,
  live,
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
}) {
  return (
    <>
      {groupActivityBlocks(blocks).map((segment, i) => {
        if (segment.kind === "activity" && needsTimeline(segment))
          return <ActivityTimeline key={i} blocks={segment.blocks} live={live} />;
        const block = segment.kind === "activity" ? segment.blocks[0]! : segment.block;
        return block.kind === "steps" ? (
          <StandaloneToolActivity
            key={i}
            live={live}
            steps={block.steps}
            toolCount={toolStepCount(block.steps)}
            durationMs={block.durationMs}
          />
        ) : null;
      })}
    </>
  );
}
