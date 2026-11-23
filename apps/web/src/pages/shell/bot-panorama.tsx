import type { Bot, BotSection, Group } from "@livingbot/contracts";
import {
  Button,
  BotAvatar,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GroupAvatar,
  SectionHeading,
} from "@livingbot/ui-web";
import { ChevronDown, CircleAlert, MessageCircle, MoreHorizontal, Pin, Plus } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { errorText } from "../../lib/user-error";

function botStatus(status: string) {
  if (status === "running" || status === "leased")
    return { label: "进行中", tone: "bg-success", motion: "working" };
  if (status === "queued")
    return { label: "已排队", tone: "bg-muted-foreground", motion: "queued" };
  if (status === "waiting_input")
    return { label: "待回复", tone: "bg-warning", motion: "waiting" };
  if (status === "waiting_takeover")
    return { label: "待接管", tone: "bg-warning", motion: "waiting" };
  if (status === "failed")
    return { label: "待核实", tone: "bg-destructive", motion: "failed" };
  return { label: "空闲", tone: "bg-muted-foreground", motion: "idle" };
}

type PanoramaBot = Pick<Bot, "id" | "name" | "status" | "color" | "avatarSet" | "pinned" | "sectionId">;

export function BotPanorama({
  bots,
  sections,
  spaces,
  onOpen,
  onCreate,
  onSettings,
  onMove,
  loading,
  loadFailed,
}: {
  bots: PanoramaBot[];
  sections: BotSection[];
  spaces?: { id: string; name: string; bots: PanoramaBot[]; botSections: BotSection[] }[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onSettings: (id: string) => void;
  onMove: (id: string, patch: { pinned?: boolean; sectionId?: string | null }) => Promise<void>;
  loading: boolean;
  loadFailed: boolean;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = (spaces?.length ? spaces : [{ id: "", name: "", bots, botSections: sections }])
    .flatMap((space) => {
    const bots = space.bots;
    const sections = space.botSections;
    return [
    { id: "pinned", name: "置顶", bots: bots.filter((bot) => bot.pinned) },
    ...sections.map((section) => ({
      id: section.id,
      name: section.name,
      bots: bots.filter((bot) => !bot.pinned && bot.sectionId === section.id),
    })),
    {
      id: "unassigned",
      name: "未分区",
      bots: bots.filter(
        (bot) =>
          !bot.pinned &&
          (!bot.sectionId || !sections.some((section) => section.id === bot.sectionId)),
      ),
    },
  ].filter((group) => group.bots.length > 0 || sections.some((section) => section.id === group.id))
    .map((group) => ({ ...group, id: `${space.id}:${group.id}`, sections,
      name: space.name ? `${space.name} · ${group.name}` : group.name }));
  });

  async function update(id: string, patch: { pinned?: boolean; sectionId?: string | null }) {
    setSaving(id);
    setError(null);
    try {
      await onMove(id, patch);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div data-testid="bot-panorama" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5 md:px-7">
        <h1 className="text-[15px] font-medium">广场</h1>
        <Button size="sm" onClick={onCreate}>
          <Plus className="size-4" />
          新建 Bot
        </Button>
      </header>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
        {error || loadFailed ? (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error ?? "暂时无法加载 Bot，请稍后重试。"}
          </p>
        ) : null}
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在加载…
          </p>
        ) : null}
        {!loading && !loadFailed && bots.length === 0 ? (
          <div className="grid min-h-60 place-items-center">
            <Button variant="outline" onClick={onCreate}>
              <Plus className="size-4" />
              新建 Bot
            </Button>
          </div>
        ) : null}
        <div className="panorama-sections">
          {groups.map((group) => (
            <Collapsible
              key={group.id}
              defaultOpen
              className="min-w-0"
              style={{ gridColumn: `span ${Math.min(4, Math.max(1, group.bots.length))}` }}
            >
              <div className="mb-3 flex h-6 items-center gap-3">
                <SectionHeading as="h2" className="shrink-0">
                  <CollapsibleTrigger className="group flex items-center gap-1.5 rounded text-sm focus-visible:outline-2 focus-visible:outline-ring">
                    {group.id.endsWith(":pinned") ? (
                      <Pin className="size-3.5" />
                    ) : (
                      <ChevronDown className="size-3.5 transition-transform group-data-[panel-open=false]:-rotate-90" />
                    )}
                    <span className="font-medium">{group.name}</span>
                    <span className="ms-1 text-xs text-muted-foreground">{group.bots.length}</span>
                  </CollapsibleTrigger>
                </SectionHeading>
                <div className="h-px flex-1 bg-border" />
              </div>
              <CollapsibleContent>
                <div
                  className="panorama-cards"
                  style={
                    {
                      "--panorama-columns": Math.min(4, Math.max(1, group.bots.length)),
                    } as CSSProperties
                  }
                >
                  {group.bots.map((bot) => {
                    const status = botStatus(bot.status);
                    return (
                      <article
                        key={bot.id}
                        data-testid={`panorama-bot-${bot.id}`}
                        data-avatar-motion={status.motion}
                        className="panorama-bot group relative min-w-0"
                      >
                        <button
                          type="button"
                          onClick={() => onOpen(bot.id)}
                          aria-label={`打开 ${bot.name} 的会话`}
                          className="panorama-bot-open flex w-full flex-col items-center rounded-lg text-start focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                        >
                          <span className="panorama-bot-portrait">
                            <BotAvatar color={bot.color} identity={bot.id} avatarSet={bot.avatarSet}
                              size={160} />
                            {status.motion === "working" && (
                              <span className="panorama-bot-aura" aria-hidden="true" />
                            )}
                          </span>
                          <span className="mt-3 flex max-w-full items-center justify-center gap-2 text-sm font-medium">
                            <span className="truncate">{bot.name}</span>
                            {status.motion === "waiting" ? (
                              <span title={status.label} className="text-warning">
                                <MessageCircle className="size-3.5" aria-hidden="true" />
                                <span className="sr-only">{status.label}</span>
                              </span>
                            ) : status.motion === "failed" ? (
                              <span title={status.label} className="text-destructive">
                                <CircleAlert className="size-3.5" aria-hidden="true" />
                                <span className="sr-only">{status.label}</span>
                              </span>
                            ) : null}
                          </span>
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button variant="ghost" size="icon-sm" />}
                            aria-label={`${bot.name} 的操作`}
                            disabled={saving === bot.id}
                            className="panorama-bot-menu absolute end-0 bottom-0 text-muted-foreground"
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onSettings(bot.id)}>
                              Bot 设置
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void update(bot.id, { pinned: !bot.pinned })}
                            >
                              {bot.pinned ? "取消置顶" : "置顶"}
                            </DropdownMenuItem>
                            {group.sections
                              .filter((section) => section.id !== bot.sectionId || bot.pinned)
                              .map((section) => (
                                <DropdownMenuItem
                                  key={section.id}
                                  onClick={() =>
                                    void update(bot.id, { sectionId: section.id, pinned: false })
                                  }
                                >
                                  移至 {section.name}
                                </DropdownMenuItem>
                              ))}
                            {bot.sectionId ? (
                              <DropdownMenuItem
                                onClick={() =>
                                  void update(bot.id, { sectionId: null, pinned: false })
                                }
                              >
                                移至未分区
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </article>
                    );
                  })}
                  {group.bots.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                      暂无 Bot
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GroupDirectory({
  groups,
  onOpen,
  onCreate,
}: {
  groups: Group[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5 md:px-7">
        <h1 className="text-[15px] font-medium">群聊</h1>
        <Button size="sm" onClick={onCreate}>
          <Plus className="size-4" />
          新建群聊
        </Button>
      </header>
      <div className="rk-scroll flex-1 overflow-y-auto p-5 md:p-7">
        {groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">暂无群聊</p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => onOpen(group.id)}
              className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 text-start hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <GroupAvatar members={group.members} size={40} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{group.name}</span>
                <span className="mt-1 block truncate text-sm text-muted-foreground">
                  {group.preview || `${group.members.length} 个成员`}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
