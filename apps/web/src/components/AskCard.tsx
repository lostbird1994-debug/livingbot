import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@livingbot/chat-ui/web";
import type { LoginFieldInput, ThreadMessage } from "@livingbot/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  commandVariableName,
  LoginSecretValue,
  loginCardFields,
} from "@livingbot/contracts";
import {
  approvalPresentation,
  isApprovalAskBlock,
  isSecretAskBlock,
  resolveAskChoice,
  selectedAskActionLabel,
} from "@livingbot/core";
import { Button, Input, Label, Switch, Textarea } from "@livingbot/ui-web";
import { Check, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { BuiCard } from "./ai/primitives";
import { LoginFieldValue } from "./LoginFields";
import { OptionRow, optionLetter } from "./OptionRow";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  secret: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
  dismissed?: boolean,
  remembered?: false,
): string {
  if (secret) return dismissed ? t`Dismissed` : remembered === false ? t`Sent` : t`Saved`;
  if (!answer) return t`Answered`;
  if (!approval) return answer === "approved" ? t`Sent` : selectedAskActionLabel(answer, actions);
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return allowsSpace(actions) ? t`Allowed in this space` : t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

/**
 * The server's labels on the user's-computer approval, whose "allow" covers the whole space. Cards
 * from before it covered the space carry the older label.
 */
const ALLOW_IN_SPACE = new Set(["Allow in this space", "Allow for this chat"]);

function allowsSpace(actions: AskBlock["actions"]): boolean {
  return actions?.some((action) => ALLOW_IN_SPACE.has(action.label)) ?? false;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
  site?: string,
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow") return ALLOW_IN_SPACE.has(fallback) ? t`Allow in this space` : t`Allow once`;
  if (id === "always") return site ? t`Always allow ${site}` : t`Always allow this tool`;
  if (id === "deny") return t`Deny`;
  return fallback;
}

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

export function AskCard({
  block,
  canAnswer,
  canDismiss,
  onAnswer,
  onDismiss,
}: {
  block: AskBlock;
  canAnswer: boolean;
  canDismiss: boolean;
  /** A login card answers with its fields and an empty `text`; `remember` false uses it once. */
  onAnswer: (text: string, fields?: LoginFieldInput[], remember?: false) => Promise<void>;
  /** Turns down a secret request without a value. */
  onDismiss: () => Promise<void>;
}) {
  const { t } = useLingui();
  const presentation = approvalPresentation(block, i18n.locale || "en");
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(block.instructionUpdate?.after ?? "");
  const [dismissed, setDismissed] = useState(false);
  const [acceptedAnswer, setAcceptedAnswer] = useState<string>();
  const [acceptedRemembered, setAcceptedRemembered] = useState<false>();
  const [undone, setUndone] = useState(false);
  const emptyLogin = () => loginCardFields(block.loginFields);
  const [login, setLogin] = useState(emptyLogin);
  const [remember, setRemember] = useState(true);
  const rememberId = useId();
  const [secretField, setSecretField] = useState<HTMLInputElement | null>(null);
  const [pastedLines, setPastedLines] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const answered = block.status === "answered" || acceptedAnswer !== undefined || dismissed;
  const displayedAnswer = block.status === "answered" ? block.answer : acceptedAnswer;
  const displayedDismissed = block.status === "answered" ? block.dismissed : dismissed;
  const displayedRemembered = block.status === "answered" ? block.remembered : acceptedRemembered;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
  const askActions = block.actions;
  const displayActions = block.instructionUpdate
    ? askActions?.flatMap((action) =>
        action.id === "allow" ? [action, { id: "edit", label: t`Edit` }] : [action],
      )
    : askActions;
  const secretInput = isSecretAskBlock(block);
  const optionQuestion =
    !approvalActions && !block.instructionUpdate && !secretInput && Boolean(askActions?.length);
  const chosenOption =
    answered && displayedAnswer ? resolveAskChoice(displayedAnswer, askActions) : undefined;
  // An edited draft is shown in the user's words, so the card reads as answered. A typed reply to
  // options already shows as the user's message, so it only dims them.
  const typedAnswer =
    answered &&
    !optionQuestion &&
    !approvalActions &&
    !secretInput &&
    !block.instructionUpdate &&
    displayedAnswer !== "approved"
      ? displayedAnswer
      : undefined;
  // A login or credential is saved for the run's user, so only they can fill one in; others see
  // the card without fields or buttons.
  const ownerOnly = secretInput && Boolean(block.credential) && !canDismiss;
  const loginInput = secretInput && block.credential?.auth.type === "login";
  const shownLoginLabels = block.loginFields ?? [t`Username`, t`Password`];
  const loginReady = LoginSecretValue.safeParse({ fields: login }).success;
  const secretLabel = secretFieldLabel(block.purpose);
  const commandInput = secretInput && block.credential?.auth.type === "command";

  // A password field can't hold line breaks, so it would flatten a multi-line command variable
  // such as an SSH private key. That text is kept as is and the field turns read-only, so what
  // is saved is exactly what was pasted; Clear makes it editable again.
  useEffect(() => {
    if (!commandInput || !secretField) return;
    const field = secretField;
    const keepLineBreaks = (event: InputEvent) => {
      const text = (event.data ?? event.dataTransfer?.getData("text/plain") ?? "").replace(
        /\r\n?/g,
        "\n",
      );
      if (field.readOnly || !event.cancelable || !text.trim().includes("\n")) return;
      event.preventDefault();
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      setAnswer(field.value.slice(0, start) + text + field.value.slice(end));
      setPastedLines(true);
    };
    field.addEventListener("beforeinput", keepLineBreaks);
    return () => field.removeEventListener("beforeinput", keepLineBreaks);
  }, [commandInput, secretField]);

  async function submitAnswer(value: string, fields?: LoginFieldInput[]) {
    if (submitting) return;
    if (fields ? !loginReady : secretInput ? value.length === 0 : !value.trim()) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) {
      setAnswer("");
      setLogin(emptyLogin());
      setPastedLines(false);
    }
    try {
      if (fields && !remember) await onAnswer(submitValue, fields, false);
      else await onAnswer(submitValue, fields);
      if (fields && !remember) setAcceptedRemembered(false);
      setAcceptedAnswer(secretInput ? "" : submitValue);
    } catch (err) {
      // A secret answer's failure may echo the secret, so never show its message.
      setError(
        secretInput
          ? t`Could not submit this answer`
          : errorText(err, t`Could not submit this answer`),
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function dismissSecret() {
    if (submitting) return;
    setPendingAction("dismiss");
    setError(null);
    setAnswer("");
    setLogin(emptyLogin());
    setPastedLines(false);
    try {
      await onDismiss();
      setDismissed(true);
    } catch {
      setError(t`Could not submit this answer`);
    } finally {
      setPendingAction(null);
    }
  }

  const { instructionUpdate, settingsUpdate } = block;
  const undo = instructionUpdate?.undoVersionId
    ? {
        label: t`Instructions updated`,
        run: () =>
          rpc.bots.restoreInstructions({
            botId: instructionUpdate.botId,
            versionId: instructionUpdate.undoVersionId!,
            expectedInstructions: instructionUpdate.after,
            undo: true,
          }),
      }
    : settingsUpdate
      ? {
          label: t`Settings updated`,
          run: () =>
            rpc.bots.update({
              botId: settingsUpdate.botId,
              ...settingsUpdate.before,
              expectedSettings: settingsUpdate.after,
            }),
        }
      : undefined;
  if (undo)
    return (
      <BuiCard className="px-5 py-4">
        <div className="flex items-center gap-2 text-sm">
          {undo.label}
          <Button
            variant="link"
            disabled={undone || submitting}
            onClick={async () => {
              setPendingAction("undo");
              setError(null);
              try {
                await undo.run();
                setUndone(true);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setPendingAction(null);
              }
            }}
          >
            {undone ? <Trans>Restored</Trans> : <Trans>Undo</Trans>}
          </Button>
          {error ? <span className="text-destructive">{error}</span> : null}
        </div>
      </BuiCard>
    );

  return (
    <BuiCard
      data-testid={
        secretInput
          ? "secret-ask-card"
          : block.instructionUpdate
            ? "instruction-approval-card"
            : approvalActions
              ? "action-approval-card"
              : undefined
      }
      className={
        approvalActions && block.approvalContext
          ? "w-full min-w-0 max-w-xl rounded-2xl border border-border/70 bg-background px-5 py-5 shadow-xs"
          : "w-full min-w-0 max-w-xl px-5 py-4"
      }
    >
      {approvalActions && block.approvalContext ? (
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <ShieldCheck aria-hidden className="size-4" />
            <span>{presentation.operation}</span>
          </div>
          <h3 className="mt-2 break-words text-base font-semibold leading-relaxed text-foreground">
            {presentation.target || presentation.operation}
          </h3>
          <p
            data-testid="ask-reason"
            className="mt-2 text-sm leading-relaxed text-muted-foreground"
          >
            {presentation.reason}
          </p>
        </div>
      ) : (
        <div className="text-[15.5px] leading-[1.5] text-foreground">
          {block.instructionUpdate ? (
            <Trans>Update instructions?</Trans>
          ) : block.approvalContext ? (
            presentation.title
          ) : (
            <ChatMarkdown>{presentation.title}</ChatMarkdown>
          )}
        </div>
      )}
      {secretInput && block.credential ? (
        <div
          data-testid="secret-ask-destination"
          className="mt-2 break-all text-[13px] text-muted-foreground"
        >
          {block.credential.auth.type === "command" ? (
            <span className="flex flex-wrap gap-x-2">
              <span>{t`Command variable`}</span>
              <span>${commandVariableName(block.credential.name)}</span>
            </span>
          ) : (
            block.credential.origin
          )}
        </div>
      ) : null}
      {approvalActions && block.approvalContext ? (
        <dl
          data-testid="ask-detail"
          className="mt-4 space-y-3 border-t border-border/60 pt-4 text-sm leading-relaxed"
        >
          {presentation.rows?.map((row, index) => (
            <div
              key={`${row.label}-${index}`}
              className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] items-start gap-x-4 gap-y-1"
            >
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                {row.before !== undefined ? (
                  <div className="mb-1 text-muted-foreground">
                    <span className="me-2 text-xs">
                      <Trans>Before</Trans>
                    </span>
                    {row.before}
                  </div>
                ) : null}
                <div>
                  {row.before !== undefined ? (
                    <span className="me-2 text-xs text-muted-foreground">
                      <Trans>After</Trans>
                    </span>
                  ) : null}
                  {row.after}
                </div>
              </dd>
            </div>
          ))}
          {!block.approvalContext.changes?.length && block.detail ? (
            <div className="whitespace-pre-wrap break-words">{block.detail}</div>
          ) : null}
        </dl>
      ) : presentation.detail && !secretInput ? (
        <pre
          data-testid="ask-detail"
          className={
            block.approvalContext || block.detailFormat === "text"
              ? "mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-[15.5px] leading-[1.5] text-foreground"
              : "mt-2.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background px-3 py-2 font-mono text-[13px] leading-[1.6] text-foreground"
          }
        >
          {presentation.detail}
        </pre>
      ) : null}
      {presentation.expandedDetail && !secretInput ? (
        <details className="mt-4 text-sm">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            {presentation.expandedLabel}
          </summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-sans text-sm leading-relaxed text-foreground">
            {presentation.expandedDetail}
          </pre>
        </details>
      ) : null}
      {block.instructionUpdate && editing && canAnswer && !answered ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(JSON.stringify({ instructions: answer }));
          }}
        >
          <Textarea
            aria-label={t`Instructions`}
            maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <Button type="submit" disabled={submitting}>
            <Trans>Apply</Trans>
          </Button>
          <Button type="button" variant="outline" onClick={() => setEditing(false)}>
            <Trans>Cancel</Trans>
          </Button>
        </form>
      ) : optionQuestion ? (
        // Options stay in place once answered: the chosen one is marked, the rest dim.
        <div className="mt-2.5 space-y-0.5">
          {askActions?.map((action, index) => (
            <OptionRow
              key={action.id}
              letter={optionLetter(index)}
              selected={chosenOption?.id === action.id}
              disabled={answered || !canAnswer || submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? <Trans>Sending…</Trans> : action.label}
            </OptionRow>
          ))}
        </div>
      ) : typedAnswer ? (
        <blockquote
          data-testid="ask-answer"
          className="mt-3 whitespace-pre-wrap break-words border-s-2 border-border ps-3 text-[15px] leading-[1.5] text-muted-foreground"
        >
          {typedAnswer}
        </blockquote>
      ) : answered ? (
        <div className="mt-3.5 flex items-center gap-1.5 text-[13.5px] font-medium text-muted-foreground">
          {displayedAnswer === "deny" ||
          displayedDismissed ||
          approvalActions?.find((action) => action.id === displayedAnswer)?.outcome ===
            "cancelled" ? null : (
            <Check aria-hidden className="size-4" />
          )}
          {block.instructionUpdate
            ? displayedAnswer === "deny"
              ? t`Dismissed`
              : t`Allowed once`
            : formatAnsweredState(
                displayedAnswer,
                Boolean(approvalActions),
                secretInput,
                approvalActions?.find((action) => action.id === displayedAnswer)?.outcome,
                askActions,
                displayedDismissed,
                displayedRemembered,
              )}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : ownerOnly ? null : displayActions?.length ? (
        <div
          className={
            block.approvalContext
              ? "mt-5 flex flex-wrap gap-2 border-t border-border/60 pt-4"
              : "mt-3.5 flex flex-wrap gap-2"
          }
        >
          {displayActions.map((action) => (
            <Button
              key={action.id}
              variant={action.id === "allow" ? "default" : "outline"}
              // Wraps long site names like the other cards' buttons.
              className="h-auto min-h-8 min-w-0 whitespace-normal py-1 text-start"
              disabled={submitting}
              onClick={() =>
                action.id === "edit" && block.instructionUpdate
                  ? setEditing(true)
                  : void submitAnswer(action.id)
              }
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : action.id === "edit" ? (
                action.label
              ) : block.instructionUpdate ? (
                action.id === "allow" ? (
                  t`Apply`
                ) : (
                  t`Dismiss`
                )
              ) : action.id === "allow" && presentation.confirmLabel ? (
                presentation.confirmLabel
              ) : action.id === "deny" && presentation.denyLabel ? (
                presentation.denyLabel
              ) : (
                approvalActionLabel(action.id, action.label, action.outcome, block.site)
              )}
            </Button>
          ))}
        </div>
      ) : secretInput ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (loginInput) void submitAnswer("", login);
            else void submitAnswer(answer);
          }}
        >
          {loginInput ? (
            login.map((field, index) => (
              <LoginFieldValue
                key={field.label}
                label={shownLoginLabels[index] ?? field.label}
                field={field}
                disabled={submitting}
                onChange={(change) =>
                  setLogin((current) =>
                    current.map((field, at) => (at === index ? { ...field, ...change } : field)),
                  )
                }
              />
            ))
          ) : (
            <Input
              ref={setSecretField}
              className="w-full"
              aria-label={secretLabel}
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              readOnly={pastedLines}
              value={pastedLines ? answer.replaceAll("\n", " ") : answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={secretLabel}
            />
          )}
          {pastedLines ? (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setPastedLines(false);
                secretField?.focus();
              }}
            >
              <Trans>Clear</Trans>
            </Button>
          ) : null}
          {loginInput ? (
            <div className="mt-1 flex items-center gap-2">
              <Switch
                id={rememberId}
                size="sm"
                checked={remember}
                disabled={submitting}
                onCheckedChange={setRemember}
              />
              <Label htmlFor={rememberId} className="text-[13px] font-normal text-muted-foreground">
                <Trans>Save to Vault</Trans>
              </Label>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={(loginInput ? !loginReady : answer.length === 0) || submitting}
            >
              {loginInput && !remember ? (
                pendingAction === "submit" ? (
                  <Trans>Sending…</Trans>
                ) : (
                  <Trans>Continue</Trans>
                )
              ) : pendingAction === "submit" ? (
                <Trans>Saving…</Trans>
              ) : (
                <Trans>Save</Trans>
              )}
            </Button>
            {canDismiss ? (
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => void dismissSecret()}
              >
                <Trans>Dismiss</Trans>
              </Button>
            ) : null}
          </div>
        </form>
      ) : editing ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <Input
            aria-label={t`Answer`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={t`Type your answer`}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={!answer.trim() || submitting}>
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setEditing(false);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <Button disabled={submitting} onClick={() => void submitAnswer("approved")}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send it</Trans>}
          </Button>
          <Button variant="outline" disabled={submitting} onClick={() => setEditing(true)}>
            <Trans>Edit first</Trans>
          </Button>
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
