import { ChatMarkdown } from "@livingbot/chat-ui/web";
import { inlineVisualMarkdown } from "@livingbot/contracts";
import { Button, Label, RadioGroup, RadioGroupItem, Textarea } from "@livingbot/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import type {
  HealthAction,
  HealthDecision,
  HealthIssue,
  HealthReport,
} from "../../../../packages/workbench/src/bot-health-types";
import { WorkbenchClient } from "../../../workbench-web/src/client";
import { localConnection } from "../lib/local-workbench";
import { errorText } from "../lib/user-error";
import { BuiCard, LoadingState } from "./ai/primitives";

const priorities = { P0: "立即处理", P1: "优先处理", P2: "建议处理", P3: "可选改善" };
const priorityChip = {
  P0: "bg-destructive/10 text-destructive",
  P1: "bg-warning/15 text-warning",
  P2: "bg-muted text-muted-foreground",
  P3: "bg-muted text-muted-foreground",
};
const choices = { defer: "暂不处理", apply: "按建议执行", other: "其他" };
type Draft = { choice?: HealthDecision["choice"]; instruction: string };

function actionStateText(action: HealthAction) {
  if (action.state === "applied")
    return action.kind === "trash" ? "已移入废纸篓" : "已改好并核对";
  if (action.state === "handed_off") return "已交给 Bot 执行";
  if (action.state === "failed") return `没做成：${action.error}`;
  return "处理中";
}

export function BotHealthCard({ botId, reportId }: { botId: string; reportId: string }) {
  const [report, setReport] = useState<HealthReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const submission = useRef(crypto.randomUUID());
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/health-reports/${encodeURIComponent(reportId)}`;
  async function request(path: string, body?: unknown) {
    const connection = await localConnection();
    if (!connection) throw new Error("请连接本机服务后查看体检报告");
    const client = new WorkbenchClient(connection.origin, connection.token);
    return client.request<HealthReport>(endpoint + path, body);
  }
  useEffect(() => {
    let active = true;
    setReport(undefined);
    setError("");
    setDrafts({});
    submission.current = crypto.randomUUID();
    void request("")
      .then((report) => {
        if (active) setReport(report);
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  useEffect(() => {
    if (!report?.batch || !["processing", "needs_review"].includes(report.batch.state)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const latest = await request("");
        if (!active) return;
        setReport(latest);
        if (!latest.batch || !["processing", "needs_review"].includes(latest.batch.state)) return;
      } catch {
        // A pending acknowledgement remains pending; reconnecting can read the saved outcome.
      }
      if (active) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [endpoint, report?.batch?.state]);
  async function update(path: string, body: Record<string, unknown>) {
    if (!report) return;
    setBusy(true);
    setError("");
    try {
      setReport(await request(path, { ...body, revision: report.revision }));
    } catch (error) {
      setError(errorText(error));
      // Read the authoritative result after an ambiguous/lost acknowledgement.
      try {
        setReport(await request(""));
      } catch {
        /* Keep the actionable error. */
      }
    } finally {
      setBusy(false);
    }
  }
  const issues = [...(report?.issues ?? [])].sort((a, b) => {
    if ((a.certainty === "unverified") !== (b.certainty === "unverified"))
      return a.certainty === "unverified" ? 1 : -1;
    return a.priority.localeCompare(b.priority);
  });
  const groups = [
    ...(["P0", "P1", "P2", "P3"] as const).flatMap((priority) => {
      const items = issues.filter(
        (issue) => issue.certainty !== "unverified" && issue.priority === priority,
      );
      return items.length ? [{ key: priority, label: `${priority} · ${priorities[priority]}`, items }] : [];
    }),
    ...(issues.some((issue) => issue.certainty === "unverified")
      ? [{ key: "unverified", label: "待确认", items: issues.filter((issue) => issue.certainty === "unverified") }]
      : []),
  ];
  const modified = report?.issues.some((issue) =>
    issue.actions.some((action) => action.state === "applied" || action.state === "handed_off"),
  );
  const pending = issues.filter(
    (issue) =>
      !issue.disposition &&
      (!issue.actions.length || issue.actions.some((action) => !action.state)),
  );
  const selected = pending.filter((issue) => drafts[issue.id]?.choice);
  const ready =
    pending.length > 0 &&
    selected.length === pending.length &&
    pending.every(
      (issue) => drafts[issue.id]?.choice !== "other" || drafts[issue.id]!.instruction.trim(),
    );
  const submitted = !!report?.batch;
  return (
    <BuiCard className="min-w-0 overflow-hidden" data-testid="bot-health-card">
      <div className="flex items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h3 className="text-[15px] font-medium tracking-tight">Bot 体检</h3>
          {report && (
            <span className="truncate text-[13px] text-muted-foreground">
              {issues.length ? `${issues.length} 项可以处理` : "没有需要处理的问题"}
            </span>
          )}
        </div>
        {report && (
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[12px] ${report.complete ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}
          >
            {report.complete ? "检查完成" : "部分完成"}
          </span>
        )}
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-3 px-5 pb-3 text-[13px] text-destructive">
          {error}
          {!report && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void request("")
                  .then((report) => {
                    setReport(report);
                    setError("");
                  })
                  .catch((error) => setError(errorText(error)))
              }
            >
              重试
            </Button>
          )}
        </div>
      )}
      {!report && !error && <LoadingState label="正在读取体检报告" />}
      {report && (
        <>
          {report.gaps.length > 0 && (
            <details className="mx-5 mb-3 rounded-[12px] bg-warning/5 px-3 py-2 text-[13px]">
              <summary className="cursor-pointer text-muted-foreground">
                还有 {report.gaps.length} 项没检查完
              </summary>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
                {report.gaps.map((gap, i) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </details>
          )}
          {groups.map((group) => (
            <section
              key={group.key}
              className="border-t border-border/60"
              aria-label={group.label}
            >
              <h4 className="px-5 pt-3 text-[12px] font-medium text-muted-foreground">
                {group.label}
              </h4>
              {group.items.map((issue) => (
                <HealthIssueView
                  key={issue.id}
                  issue={issue}
                  busy={busy || submitted}
                  draft={drafts[issue.id]}
                  onChange={(draft) =>
                    setDrafts((previous) => ({ ...previous, [issue.id]: draft }))
                  }
                />
              ))}
            </section>
          ))}
          {!issues.length && (
            <p className="px-5 pb-4 text-[13.5px] text-muted-foreground">
              {report.complete
                ? "这次没有发现需要处理的问题。"
                : "已检查的部分没问题，其余项目还没查完。"}
            </p>
          )}
          {report.batch ? (
            <div className="space-y-2 border-t border-border/60 bg-muted/20 px-5 py-3.5" role="status">
              <p
                className={`text-[13px] font-medium ${report.batch.state === "failed" ? "text-destructive" : report.batch.state === "completed" ? "text-success" : ""}`}
              >
                {report.batch.state === "completed"
                  ? "已按你的选择处理"
                  : report.batch.state === "needs_review"
                    ? "已提交，Bot 正在调整方案"
                    : report.batch.state === "review_ready"
                      ? "新方案已发到会话里"
                      : report.batch.state === "failed"
                        ? "这次没有全部处理完"
                        : "正在处理…"}
              </p>
              {report.batch.error && (
                <p className="text-[13px] text-destructive">{report.batch.error}</p>
              )}
              <ul className="space-y-0.5 text-[13px] text-muted-foreground">
                {report.batch.decisions.map((decision) => (
                  <li key={decision.issueId}>
                    {issues.find((issue) => issue.id === decision.issueId)?.title}：
                    {decision.choice === "other"
                      ? `其他 · ${decision.instruction}`
                      : choices[decision.choice]}
                  </li>
                ))}
              </ul>
              {modified && (
                <p className="text-[13px] text-muted-foreground">
                  改过的内容都核对过；实际效果会在下次体检复查。
                </p>
              )}
            </div>
          ) : (
            pending.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-5 py-3">
                <span className="text-[13px] text-muted-foreground" aria-live="polite">
                  已选 {selected.length} / {pending.length} 项
                </span>
                <Button
                  size="sm"
                  disabled={busy || !ready}
                  onClick={() => {
                    if (!report) return;
                    void update("/decisions", {
                      submissionId: submission.current,
                      decisions: pending.map((issue) => ({
                        issueId: issue.id,
                        choice: drafts[issue.id]!.choice,
                        ...(drafts[issue.id]!.choice === "other"
                          ? { instruction: drafts[issue.id]!.instruction.trim() }
                          : {}),
                      })),
                    });
                  }}
                >
                  {busy ? "正在提交…" : "提交并处理"}
                </Button>
              </div>
            )
          )}
        </>
      )}
    </BuiCard>
  );
}

function HealthIssueView({
  issue,
  busy,
  draft,
  onChange,
}: {
  issue: HealthIssue;
  busy: boolean;
  draft?: Draft;
  onChange: (draft: Draft) => void;
}) {
  const reasonId = useId();
  const open = issue.actions.filter((action) => !action.state);
  const done = issue.actions.filter((action) => action.state);
  const pending = !issue.actions.length || open.length > 0;
  return (
    <article className="px-5 pb-4 pt-2" aria-label={issue.title}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        {issue.certainty === "unverified" && (
          <>
            <span
              className={`rounded-[5px] px-1.5 py-0.5 font-medium ${priorityChip[issue.priority]}`}
            >
              {issue.priority}
            </span>
            <span className="text-warning">证据不足</span>
          </>
        )}
        {issue.certainty === "suggestion" && (
          <span className="text-muted-foreground">改善建议</span>
        )}
        {issue.disposition && (
          <span className="text-muted-foreground">
            {issue.disposition === "deferred" ? "暂不处理" : "已关闭"}
          </span>
        )}
      </div>
      <h5 className="mt-1.5 text-[15px] font-medium leading-[1.45]">{issue.title}</h5>
      <p className="mt-1 text-[13.5px] leading-[1.65] text-foreground/80">{issue.problem}</p>
      <p className="mt-1 text-[13px] leading-[1.65] text-muted-foreground">
        <span className="text-foreground/60">影响　</span>
        {issue.impact}
      </p>
      {issue.plan?.steps.length ? (
        <ol className="mt-2.5 space-y-1 border-l-2 border-border pl-3 text-[13.5px] leading-[1.65]">
          {issue.plan.steps.map((step, index) => (
            <li key={index} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {done.map((action) => (
        <p
          key={action.id}
          className={`mt-2 break-words text-[12.5px] ${action.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {actionStateText(action)}
          {action.kind === "instruction" ? `（${action.target}）` : ` · ${action.path}`}
          {action.recovery && <span className="block break-all">恢复位置：{action.recovery}</span>}
        </p>
      ))}
      <div className="mt-2 space-y-1 text-[12.5px] text-muted-foreground">
        {issue.evidence.length > 0 && (
          <details>
            <summary className="w-fit cursor-pointer">依据</summary>
            <div className="mt-1.5 space-y-2">
              {issue.evidence.map((evidence, i) => (
                <div key={i}>
                  <p className="break-all text-foreground/70">{evidence.path}</p>
                  <blockquote className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3">
                    {evidence.excerpt}
                  </blockquote>
                </div>
              ))}
            </div>
          </details>
        )}
        {open.length > 0 && (
          <details>
            <summary className="w-fit cursor-pointer">具体改动</summary>
            <div className="mt-1.5 space-y-3">
              {open.map((action) =>
                action.kind === "instruction" ? (
                  <div key={action.id} className="space-y-1.5">
                    <p className="break-all text-foreground/70">交给 Bot 执行：{action.target}</p>
                    <p>{action.explanation}</p>
                    {action.steps?.length ? (
                      <ol className="list-decimal space-y-1 pl-4">
                        {action.steps.map((step, index) => (
                          <li key={index}>{step}</li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                ) : (
                  <div key={action.id} className="space-y-1.5">
                    <p className="break-all text-foreground/70">
                      {action.kind === "trash" ? "移入废纸篓：" : "修改："}
                      {action.path}
                    </p>
                    <p>{action.explanation}</p>
                    {action.retainedPath && <p className="break-all">保留：{action.retainedPath}</p>}
                    {action.uniqueContent && <p>{action.uniqueContent}</p>}
                    {action.content !== undefined && (
                      <details>
                        <summary className="cursor-pointer">修改前后全文</summary>
                        <p className="mt-1.5">修改前</p>
                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                          {action.beforeContent}
                        </pre>
                        <p className="mt-1.5">修改后</p>
                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                          {action.content}
                        </pre>
                      </details>
                    )}
                  </div>
                ),
              )}
            </div>
          </details>
        )}
        {issue.plan?.limitation && <p className="text-warning">{issue.plan.limitation}</p>}
        {issue.plan?.diagram && (
          <ChatMarkdown>{`\`\`\`mermaid\n${issue.plan.diagram}\n\`\`\``}</ChatMarkdown>
        )}
        {issue.plan?.illustration && (
          <ChatMarkdown>
            {inlineVisualMarkdown({
              version: 1,
              kind: "widget",
              title: issue.plan.illustration.title,
              description: issue.suggestion.slice(0, 500),
              format: issue.plan.illustration.format,
              code: issue.plan.illustration.code,
            })}
          </ChatMarkdown>
        )}
      </div>
      {!issue.disposition && pending && (
        <fieldset className="mt-3" disabled={busy}>
          <legend className="sr-only">{issue.title}的处理方式</legend>
          <RadioGroup
            className="flex w-fit items-center gap-0.5 rounded-[10px] bg-foreground/[0.05] p-[3px]"
            value={draft?.choice ?? ""}
            onValueChange={(choice) =>
              onChange({
                choice: choice as HealthDecision["choice"],
                instruction: draft?.instruction ?? "",
              })
            }
            aria-label={`${issue.title}的处理方式`}
          >
            {(["defer", "apply", "other"] as const).map((choice) => {
              const active = draft?.choice === choice;
              const unavailable = choice === "apply" && !open.length;
              return (
                <Label
                  key={choice}
                  htmlFor={`${reasonId}-${choice}`}
                  className={`flex cursor-pointer items-center rounded-[8px] px-3 py-1.5 text-[13px] transition-colors ${
                    active
                      ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground"
                  } ${unavailable ? "pointer-events-none opacity-40" : ""}`}
                >
                  <RadioGroupItem
                    id={`${reasonId}-${choice}`}
                    value={choice}
                    data-choice={choice}
                    disabled={busy || unavailable}
                    className="sr-only"
                  />
                  {choices[choice]}
                </Label>
              );
            })}
          </RadioGroup>
          {draft?.choice === "other" && (
            <div className="mt-2 space-y-1.5">
              <Label htmlFor={reasonId} className="text-[13px] text-muted-foreground">
                你希望怎么处理？
              </Label>
              <Textarea
                id={reasonId}
                value={draft.instruction}
                onChange={(event) => onChange({ ...draft, instruction: event.target.value })}
                disabled={busy}
                maxLength={2000}
                rows={3}
                className="text-[13px]"
              />
              <p className="text-[12.5px] text-muted-foreground">
                会先给你一份新方案，确认后才动手。
              </p>
            </div>
          )}
        </fieldset>
      )}
    </article>
  );
}
