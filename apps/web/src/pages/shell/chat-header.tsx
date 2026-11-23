import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@livingbot/contracts";
import {
  BotAvatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GroupAvatar,
} from "@livingbot/ui-web";
import { History, Menu, MoreHorizontal, Plus, Search } from "lucide-react";

/** The chat's title bar: navigation, the chat's name and its rarer actions. Owns its own row so the transcript never scrolls under it. */
export function ChatHeader({
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  panelOpen,
  onOpenNavigation,
  onTogglePanel,
  onNewSession,
  onAllSessions,
  sessionCount,
  onFind,
}: {
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  panelOpen: boolean;
  onOpenNavigation: () => void;
  onTogglePanel: () => void;
  /** Present while the chat has only its main session open and no tabs are shown. */
  onNewSession?: () => void;
  onAllSessions?: () => void;
  sessionCount?: number;
  onFind?: () => void;
}) {
  const { t } = useLingui();
  const hasMenu = Boolean(onNewSession || onAllSessions || onFind);
  return (
    <div className="app-drag relative z-10 grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 border-b border-border/60 bg-transparent px-3 py-2 md:px-[22px]">
      <div className="flex items-center">
        <Button
          variant="floating"
          size="icon-lg"
          aria-label={t`Open navigation`}
          onClick={onOpenNavigation}
          className="app-no-drag md:hidden"
        >
          <Menu strokeWidth={1.7} className="size-[19px]" />
        </Button>
      </div>
      <Button
        variant="floating"
        data-testid="bot-settings-trigger"
        aria-expanded={panelOpen}
        onClick={onTogglePanel}
        className="app-no-drag h-auto min-w-0 gap-2 py-1 ps-1 pe-3.5"
      >
        {inGroup ? (
          <GroupAvatar members={activeSnapshot?.members ?? activeGroup?.members ?? []} size={26} />
        ) : active ? (
          <BotAvatar
            avatarSet={active.avatarSet}
            color={active.color}
            identity={active.id}
            size={26}
            status={active.status}
          />
        ) : null}
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-medium text-foreground" dir="auto">
            {inGroup
              ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
              : (active?.name ?? t`Select a bot`)}
          </span>
        </span>
      </Button>
      <div className="flex items-center justify-self-end">
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="chat-more-button"
              aria-label={t`More`}
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="app-no-drag rounded-full text-muted-foreground hover:text-foreground"
                />
              }
            >
              <MoreHorizontal strokeWidth={1.7} className="size-[19px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-44">
              {onNewSession ? (
                <DropdownMenuItem onClick={onNewSession}>
                  <Plus />
                  新会话
                </DropdownMenuItem>
              ) : null}
              {onAllSessions ? (
                <DropdownMenuItem onClick={onAllSessions}>
                  <History />
                  全部会话
                  {sessionCount ? (
                    <span className="ms-auto text-muted-foreground tabular-nums">{sessionCount}</span>
                  ) : null}
                </DropdownMenuItem>
              ) : null}
              {onFind ? (
                <DropdownMenuItem onClick={onFind}>
                  <Search />
                  查找此对话
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
