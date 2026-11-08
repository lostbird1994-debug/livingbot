import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { Bot, BotRoleCard } from "@rakazo/contracts";
import { BOT_ROLE_TEXT_MAX_LENGTH, botRoleCard, excludesSharedProfile } from "@rakazo/contracts";
import { Button, Switch, Textarea } from "@rakazo/ui-web";
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
    {
      key: "userIdentity",
      title: t`User identity`,
      toggle: "userIdentityEnabled",
      switchLabel: t`Enable user identity`,
    },
    {
      key: "backstory",
      title: t`Backstory`,
      toggle: "backstoryEnabled",
      switchLabel: t`Enable backstory`,
    },
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
    <section className="space-y-4" data-testid="bot-role-card-editor">
      {fields.map((field) => (
        <div key={field.key} className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor={`${id}-${field.key}`}
              className="text-xs font-medium text-muted-foreground"
            >
              {field.title}
            </label>
            {"toggle" in field ? (
              <Switch
                aria-label={field.switchLabel}
                checked={draft[field.toggle]}
                disabled={pending}
                onCheckedChange={(checked) => set(field.toggle, checked)}
              />
            ) : null}
          </div>
          <Textarea
            id={`${id}-${field.key}`}
            aria-label={field.title}
            value={draft[field.key]}
            maxLength={BOT_ROLE_TEXT_MAX_LENGTH}
            disabled={pending}
            rows={3}
            className="min-h-20 resize-y bg-muted/50 text-sm"
            onChange={(event) => set(field.key, event.target.value)}
          />
          {field.key === "identity" ? <InstructionSettings bot={bot} onSaved={onSaved} /> : null}
        </div>
      ))}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {excludesSharedProfile(draft) ? (
          <Trans>
            After saving, shared USER.md, MEMORY.md and profile.md will not load automatically. This
            bot's own memory stays available.
          </Trans>
        ) : (
          <Trans>
            User identity and backstory load only when their switches are on. Shared memory follows
            the usual loading rules.
          </Trans>
        )}
      </p>
      <div className="flex items-center gap-2">
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {conflict ? t`Role settings changed elsewhere. Reload before saving.` : error}
        </p>
      ) : null}
      {publicProfile}
    </section>
  );
}
