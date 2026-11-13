import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { Bot, BotRoleCard } from "@livingbot/contracts";
import { BOT_ROLE_TEXT_MAX_LENGTH, botRoleCard } from "@livingbot/contracts";
import { Button, Disclosure, SectionHeading, Textarea } from "@livingbot/ui-web";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { InstructionSettings } from "../components/InstructionSettings";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

export function BotRoleCardEditor({
  bot,
  publicProfile,
  onSaved,
}: {
  bot: Bot;
  publicProfile?: ReactNode;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const id = useId();
  const source = JSON.stringify(botRoleCard(bot.roleCard));
  const [seen, setSeen] = useState(source);
  const [baseline, setBaseline] = useState(() => botRoleCard(bot.roleCard));
  const [draft, setDraft] = useState(baseline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [openFields, setOpenFields] = useState<Record<string, boolean>>({});
  const [seenInstructions, setSeenInstructions] = useState(bot.instructions);
  const [instructionPreview, setInstructionPreview] = useState(bot.instructions);
  if (seenInstructions !== bot.instructions) {
    setSeenInstructions(bot.instructions);
    setInstructionPreview(bot.instructions);
  }
  if (seen !== source) {
    setSeen(source);
    if (JSON.stringify(draft) === JSON.stringify(baseline)) {
      const next = botRoleCard(bot.roleCard);
      setBaseline(next);
      setDraft(next);
    }
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const fields = [
    { key: "identity", title: t`Identity` },
    { key: "personality", title: t`Personality` },
    { key: "userIdentity", title: t`User identity` },
  ] as const;
  function set<K extends keyof BotRoleCard>(key: K, value: BotRoleCard[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function save() {
    setPending(true);
    setError("");
    try {
      const updated = await rpc.bots.update({
        botId: bot.id,
        roleCard: draft,
        expectedRoleCard: baseline,
      });
      const saved = botRoleCard(updated.roleCard);
      setBaseline(saved);
      setDraft(saved);
      setConflict(false);
      onSaved();
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ORPCError && err.code === "CONFLICT") setConflict(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-2" data-testid="bot-role-card-editor">
      <SectionHeading variant="label">
        <Trans>Role and instructions</Trans>
      </SectionHeading>
      {fields.map((field) => (
        <div key={field.key}>
          <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-card px-4 shadow-xs">
            <Disclosure
              open={openFields[field.key] ?? false}
              onOpenChange={(open) =>
                setOpenFields((current) => ({ ...current, [field.key]: open }))
              }
              className="min-w-0 flex-1"
              summaryClassName="w-full justify-between py-3 text-sm"
              contentClassName="pb-3"
              summary={
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium">{field.title}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {!draft[field.key].trim()
                          ? t`Not filled in`
                          : null}
                    </span>
                  </span>
                  {!openFields[field.key] && draft[field.key].trim() ? (
                    <span className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground group-data-panel-open/disclosure:hidden">
                      {draft[field.key]}
                    </span>
                  ) : null}
                </span>
              }
            >
              <Textarea
                id={`${id}-${field.key}`}
                aria-label={field.title}
                value={draft[field.key]}
                maxLength={BOT_ROLE_TEXT_MAX_LENGTH}
                disabled={pending}
                rows={6}
                className="max-h-96 min-h-32 resize-y bg-muted/50 text-sm"
                onChange={(event) => set(field.key, event.target.value)}
              />
            </Disclosure>
          </div>
          {field.key === "identity" ? (
            <Disclosure
              open={openFields.instructions ?? false}
              onOpenChange={(open) =>
                setOpenFields((current) => ({ ...current, instructions: open }))
              }
              className="mt-2 rounded-xl border border-border/70 bg-card px-4 shadow-xs"
              summaryClassName="w-full justify-between py-3 text-sm"
              contentClassName="pb-3"
              summary={
                <span className="min-w-0">
                  <span className="block font-medium">
                    <Trans>Instructions</Trans>
                  </span>
                  {!openFields.instructions ? (
                    <span className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                      {instructionPreview.trim() || t`Not filled in`}
                    </span>
                  ) : null}
                </span>
              }
            >
              <InstructionSettings
                bot={bot}
                onSaved={(updated) => {
                  setInstructionPreview(updated.instructions);
                  onSaved();
                }}
                compact
              />
            </Disclosure>
          ) : null}
        </div>
      ))}
      {dirty || conflict ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 bg-background py-2">
          {dirty ? (
            <span className="text-xs text-muted-foreground">
              <Trans>Unsaved changes</Trans>
            </span>
          ) : null}
          <Button size="sm" disabled={pending || conflict || !dirty} onClick={() => void save()}>
            <Trans>Save role settings</Trans>
          </Button>
          {dirty ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setDraft(baseline);
                setError("");
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          ) : null}
          {conflict ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                try {
                  const latest = await rpc.bots.get({ botId: bot.id });
                  const card = botRoleCard(latest.roleCard);
                  setBaseline(card);
                  setDraft(card);
                  setConflict(false);
                  setError("");
                  onSaved();
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setPending(false);
                }
              }}
            >
              <Trans>Reload</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {conflict ? t`Role settings changed elsewhere. Reload before saving.` : error}
        </p>
      ) : null}
      <Disclosure
        className="rounded-xl border border-border/70 bg-card px-4 shadow-xs"
        summaryClassName="w-full justify-between py-3 text-sm"
        contentClassName="pb-3"
        summary={<Trans>Profile shown to other bots</Trans>}
      >
        {publicProfile}
      </Disclosure>
    </section>
  );
}
