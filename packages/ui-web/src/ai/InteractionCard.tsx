import { useRef, useState } from "react";
import { Check, ChevronRight, CircleHelp, ShieldCheck } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import type { Interaction, InteractionAnswer } from "../../../workbench/src/contracts.js";
import type { InteractionDraft } from "./interaction-draft.js";
import { readInteractionDraft, saveInteractionDraft } from "./interaction-draft.js";
export type { InteractionDraft } from "./interaction-draft.js";

const decisions = { "allow-once": "允许这次", "allow-always": "始终允许", deny: "拒绝" };
// Translate native analysis enums only; do not classify the command text.
const nativeRiskLabels: Record<string, string> = {
  "inline-eval": "将直接运行一段代码",
  "shell-wrapper": "将通过 Shell 启动命令",
  "command-carrier": "还会执行嵌套命令",
  "dynamic-argument": "部分参数在运行时确定",
  source: "将加载并执行脚本",
  "function-definition": "包含自定义函数",
};
const statusText = {
  pending: "等待你",
  answering: "确认中",
  answered: "已答复",
  cancelled: "已跳过",
  expired: "已过期",
  unavailable: "当前不可答复",
};

export function InteractionCard({
  prompt,
  client,
  onResolved,
  draft,
  onDraftChange,
}: {
  prompt: Interaction;
  client: {
    resolveInteraction(taskId: string, id: string, answer: InteractionAnswer): Promise<Interaction>;
  };
  onResolved(prompt: Interaction): void;
  draft?: InteractionDraft;
  onDraftChange(draft: InteractionDraft): void;
}) {
  const [initialDraft] = useState(() => draft ?? readInteractionDraft(prompt.id));
  const answers = draft?.answers ?? initialDraft?.answers ?? {};
  const other = draft?.other ?? initialDraft?.other ?? {};
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  // Preserve the exact answer and identity after an uncertain transport reply.
  const pendingAnswer = useRef<InteractionAnswer | undefined>(initialDraft?.pendingAnswer);
  const open = prompt.status === "pending" || prompt.status === "answering";

  function updateDraft(next: InteractionDraft) {
    // Persist before sending so a reload retries the same resolution identity.
    saveInteractionDraft(prompt.id, next);
    onDraftChange(next);
  }

  async function submit(answer: InteractionAnswer) {
    if (sending) return;
    pendingAnswer.current ??= answer;
    updateDraft({ answers, other, pendingAnswer: pendingAnswer.current });
    setSending(true);
    setError(undefined);
    try {
      onResolved(await client.resolveInteraction(prompt.taskId, prompt.id, pendingAnswer.current));
      pendingAnswer.current = undefined;
      updateDraft({ answers, other });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  if (prompt.kind === "approval") {
    const metadata = prompt.approval;
    const operation =
      metadata?.host === "node"
        ? "运行节点命令"
        : metadata?.host === "sandbox"
          ? "运行沙箱命令"
          : "运行本机命令";
    const analysis = metadata?.commandAnalysis;
    const context = (
      <>
        {metadata?.taskTitle && (
          <p className="whitespace-pre-wrap break-words text-sm">所属任务：{metadata.taskTitle}</p>
        )}
        {metadata?.cwd && (
          <p className="break-all text-xs text-muted-foreground">工作目录：{metadata.cwd}</p>
        )}
        {metadata?.warningText && (
          <p className="whitespace-pre-wrap break-words text-xs text-warning">
            执行提示：{metadata.warningText}
          </p>
        )}
        {Boolean(analysis?.riskKinds.length) && (
          <p className="break-words text-xs text-warning">
            内核识别：{analysis!.riskKinds.map((kind) => nativeRiskLabels[kind] ?? kind).join("、")}
          </p>
        )}
        {!metadata?.warningText && !analysis?.riskKinds.length && !analysis?.warningLines.length && (
          <p className="text-xs text-muted-foreground">内核未提供风险说明，请核对命令后决定。</p>
        )}
        {Boolean(analysis?.warningLines.length) && (
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            风险详情：{analysis!.warningLines.join("\n")}
          </p>
        )}
      </>
    );
    const command = (
      <>
        <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
          <code>{metadata?.command ?? prompt.title}</code>
        </pre>
      </>
    );
    const outcome = prompt.answer?.decision
      ? { "allow-once": "已允许这次", "allow-always": "已始终允许", deny: "已拒绝" }[
          prompt.answer.decision
        ]
      : statusText[prompt.status];
    if (!open)
      return (
        <details
          className="group min-w-0 rounded-lg border border-border bg-card text-sm"
          aria-label="操作审批"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
            <ShieldCheck size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="shrink-0">{outcome}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{operation}</span>
            <ChevronRight
              size={14}
              className="ml-auto shrink-0 text-muted-foreground group-open:rotate-90"
              aria-hidden="true"
            />
          </summary>
          <div className="space-y-2 px-3 pb-3">
            {context}
            {command}
          </div>
        </details>
      );
    return (
      <section
        className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3 text-sm"
        aria-label="操作审批"
      >
        <header className="flex items-center gap-2">
          <ShieldCheck size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{operation}</span>
          {prompt.status === "answering" && (
            <small className="ml-auto text-muted-foreground">确认中</small>
          )}
        </header>
        {context}
        <details open className="text-xs">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            待执行命令
          </summary>
          <div className="mt-2">{command}</div>
        </details>
        {prompt.decisions.includes("allow-always") && !pendingAnswer.current && (
          <p className="text-xs text-muted-foreground">“始终允许”会保存授权，后续匹配的操作可直接运行。</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {pendingAnswer.current ? (
            <Button
              size="sm"
              disabled={sending}
              onClick={() => void submit(pendingAnswer.current!)}
            >
              重试确认
            </Button>
          ) : (
            prompt.decisions.map((decision) => (
              <Button
                key={decision}
                size="sm"
                disabled={sending || prompt.status === "answering"}
                variant={
                  decision === "deny" ? "ghost" : decision === "allow-once" ? "default" : "outline"
                }
                onClick={() => void submit({ resolutionId: crypto.randomUUID(), decision })}
              >
                {decisions[decision]}
              </Button>
            ))
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-5 text-sm" aria-label="等待答复">
      <header className="mb-4 flex items-center gap-2">
        <CircleHelp size={17} />
        <span>有件事想确认</span>
        <small className="ml-auto text-muted-foreground">{statusText[prompt.status]}</small>
      </header>
      {prompt.questions.map((field) => (
        <fieldset
          className="mb-4 min-w-0 space-y-2"
          key={field.id}
          disabled={!open || sending || Boolean(pendingAnswer.current)}
        >
          <legend className="mb-2">{field.question}</legend>
          {open && (
            <div className="grid gap-2">
              {field.options.map((option) => {
                const selected =
                  (open ? answers : prompt.answer?.answers)?.[field.id]?.includes(option.value) ??
                  false;
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant="outline"
                    className="h-auto justify-between whitespace-normal text-left"
                    aria-pressed={selected}
                    onClick={() =>
                      updateDraft({
                        answers: {
                          ...answers,
                          [field.id]: field.multiSelect
                            ? selected
                              ? (answers[field.id] ?? []).filter((value) => value !== option.value)
                              : [...(answers[field.id] ?? []), option.value]
                            : [option.value],
                        },
                        other: field.multiSelect ? other : { ...other, [field.id]: "" },
                      })
                    }
                  >
                    <span>
                      {option.label}
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {selected && <Check size={15} />}
                  </Button>
                );
              })}
            </div>
          )}
          {open && field.allowOther && (
            <Input
              aria-label={`${field.header || field.question}：其他答案`}
              placeholder="其他…"
              value={other[field.id] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                const selected = field.multiSelect
                  ? (answers[field.id] ?? []).filter((answer) =>
                      field.options.some((option) => option.value === answer),
                    )
                  : [];
                updateDraft({
                  other: { ...other, [field.id]: value },
                  answers: {
                    ...answers,
                    [field.id]: [...new Set([...selected, ...(value.trim() ? [value] : [])])],
                  },
                });
              }}
            />
          )}
          {!open &&
            prompt.answer?.answers?.[field.id]?.map((value, index) => (
              <p key={index}>
                {field.options.find((option) => option.value === value)?.label ?? value}
              </p>
            ))}
        </fieldset>
      ))}
      {!open && prompt.answer?.decision && <p>{decisions[prompt.answer.decision]}</p>}
      {open && (
        <div className="flex flex-wrap justify-end gap-2">
          {pendingAnswer.current ? (
            <Button disabled={sending} onClick={() => void submit(pendingAnswer.current!)}>
              重试确认
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={sending}
                onClick={() => void submit({ resolutionId: crypto.randomUUID(), cancel: true })}
              >
                跳过
              </Button>
              <Button
                disabled={sending || !prompt.questions.every((field) => answers[field.id]?.length)}
                onClick={() => void submit({ resolutionId: crypto.randomUUID(), answers })}
              >
                继续
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
