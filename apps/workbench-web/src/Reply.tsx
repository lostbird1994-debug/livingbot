import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Block, Message } from "../../../packages/workbench/src/contracts.ts";
import type { WorkbenchClient } from "./client.ts";
import { FileCard } from "./FileCard.tsx";
import { Content } from "./Document.tsx";
import { Widget } from "./Widget.tsx";
import {
  blockCost, computeSegments, mergeNarration, phaseLabel, processSummary, processView, reasoningComplete,
  replyLive, stepLive, visibleStart,
} from "./reply-state.ts";
import type { ProcessSegment } from "./reply-state.ts";
import type { ReplyActivity } from "./reply-state.ts";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { MessageSquare, UsersRound } from "lucide-react";

const toolNames: Record<string, string> = {
  ask_user: "向你确认", livingbot_conversations: "回顾对话",
  livingbot_deliver_file: "交付文件", livingbot_report_privately: "私聊汇报",
  livingbot_assign_group: "分派群内工作",
  show_widget: "生成交互预览",
};

/**
 * One reasoning stage. It stays open while it is the live stage, follows its own
 * tail only when the reader has not scrolled up, and closes when the stage ends;
 * a finished stage can still be reopened by hand.
 */
function ReasoningStage({ text, live, complete }: {
  text: string; live: boolean; complete: boolean;
}) {
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDetailsElement>(null);
  const trustsTail = useRef(true);
  const openAtMount = useRef(!complete).current;
  const wasComplete = useRef(complete);
  useEffect(() => {
    if (!panel.current || complete === wasComplete.current) return;
    wasComplete.current = complete;
    panel.current.open = !complete;
  }, [complete]);
  useEffect(() => {
    const node = body.current;
    // A reader who scrolled up owns the position; streaming must not yank it back.
    if (!node || !live || complete || !trustsTail.current) return;
    node.scrollTop = node.scrollHeight;
  }, [text, live, complete]);
  return <details className="reasoning" ref={panel} open={openAtMount}>
    <summary>思考</summary>
    <div ref={body} onScroll={(event) => {
      const node = event.currentTarget;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (distance > 20) trustsTail.current = false;
      else if (distance < 10) trustsTail.current = true;
    }}>{text}</div>
  </details>;
}

function Step({ block, live }: { block: Block; live: boolean }) {
  if (block.kind === "reasoning") return <ReasoningStage text={block.text} live={live} complete={!live} />;
  if (block.kind === "tool") return <div className="tool-step">
    <span className="tool-mark" /><span>{toolNames[block.name] ?? block.title}</span>
    <small>{phaseLabel(block.phase, live)}</small>
    {block.detail && <details className="tool-detail"><summary>详情</summary><pre>{block.detail}</pre></details>}
  </div>;
  if (block.kind === "text") return <div className="commentary"><Content text={block.text} /></div>;
  return null;
}

/**
 * A run of consecutive steps folds as one group; narration between steps stays
 * outside it. Long groups render from the end in bounded batches, so a hundred
 * steps do not become one enormous panel.
 */
function StepGroup({ segment, live, tail }: { segment: Extract<ProcessSegment, { kind: "group" }>; live: boolean; tail: boolean }) {
  const [batches, setBatches] = useState(1);
  const costs = segment.blocks.map(blockCost);
  const start = visibleStart(costs, 15 * batches, 24_576 * batches);
  return <details className="process-group" open={live && tail}>
    <summary>{segment.blocks.length} 个步骤</summary>
    {start > 0 && <button type="button" className="process-earlier" onClick={() => setBatches((value) => value + 1)}>
      显示更早的 {start} 项
    </button>}
    {segment.blocks.slice(start).map((block, index) => <Step key={block.id} block={block}
      live={stepLive(live && tail, start + index, segment.blocks.length)} />)}
  </details>;
}

function Process({ blocks, view, live }: { blocks: Block[]; view: { open: boolean; label: string }; live: boolean }) {
  const visible = blocks.filter((block) => block.kind !== "tool" || block.name !== "dispatch_action" ||
    !blocks.some((child) => child.kind === "tool" && child.parentId === block.id));
  // Consecutive narration belongs to one thought; keeping it separate fragments the run.
  const merged = mergeNarration(visible);
  const segments = computeSegments(merged);
  return <details className="execution-process" open={view.open}>
    <summary>{view.label}<span>{processSummary(merged)}</span></summary>
    {segments.map((segment, index) => segment.kind === "group"
      ? <StepGroup key={segment.id} segment={segment} live={live} tail={index === segments.length - 1} />
      : segment.block.kind === "reasoning"
        ? <ReasoningStage key={segment.block.id} text={segment.block.text} live={live}
          complete={reasoningComplete(live, merged.indexOf(segment.block), merged.length)} />
        : <Step key={segment.block.id} block={segment.block} live={live} />)}
  </details>;
}

export function Reply({ message, name, activity, children, client, reportSource, reportTarget, taskControls, steeringDelivered, shareControl }: {
  message: Message; name: string; activity?: ReplyActivity; children?: ReactNode; client: WorkbenchClient;
  reportSource?: { title: string; open: () => void };
  reportTarget?: () => void;
  taskControls?: ReactNode;
  steeringDelivered?: boolean;
  shareControl?: ReactNode;
}) {
  const finalIndex = message.final ? message.blocks.findLastIndex((block) => block.kind === "text") : -1;
  const process = (finalIndex < 0 ? message.blocks : message.blocks.slice(0, finalIndex))
    .filter((block) => block.kind === "text" || block.kind === "tool" || block.kind === "reasoning");
  const final = finalIndex >= 0 ? message.blocks[finalIndex] : undefined;
  const view = processView(message.final, activity);
  return <article className={`reply reply-${message.role}`} data-task-id={message.taskId} data-message-id={message.id} tabIndex={-1}>
    <header><span className="reply-author">{message.role === "user" ? "你" : name}</span>
      <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
      {reportSource && <Button type="button" size="sm" variant="ghost" className="report-source"
        onClick={reportSource.open}><UsersRound />{reportSource.title}</Button>}
      {shareControl}</header>
    {message.role === "user" ? message.blocks.map((block) => block.kind === "text" && <div className="user-body" key={block.id}>{block.text}</div>) : <>
      {process.length > 0 && <Process blocks={process} view={view} live={replyLive(message.final, activity)} />}
      {children}
      {final?.kind === "text" && <div className="document-body"><Content text={final.text} /></div>}
      {steeringDelivered && !message.blocks.length && <div className="commentary" role="status">补充已送达</div>}
    </>}
    {message.blocks.map((block) => block.kind === "file" ? <FileCard key={block.id} id={block.artifactId}
      name={block.name} mediaType={block.mediaType} client={client} /> : block.kind === "widget"
        ? <Widget key={block.id} block={block} message={message} client={client} /> : null)}
    {taskControls}
    {reportTarget && <Button type="button" size="sm" variant="ghost" className="report-target"
      onClick={reportTarget}><MessageSquare />查看私聊汇报</Button>}
  </article>;
}
