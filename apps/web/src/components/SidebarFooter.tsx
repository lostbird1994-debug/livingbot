import { Trans, useLingui } from "@lingui/react/macro";
import type { NavLink } from "@livingbot/contracts";
import {
  AppMarkStack,
  Button,
  buttonVariants,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@livingbot/ui-web";
import {
  BookOpen,
  Download,
  FolderOpen,
  Gauge,
  Link2,
  LogOut,
  Plug,
  ScrollText,
  Settings,
  ChevronRight,
  SquareKanban,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { SettingsPanel } from "../pages/settings-nav";
import { SETTINGS_PANELS, useSettingsPanelLabels } from "../pages/settings-nav";
import { useSidebarUpdate } from "./DesktopUpdates";
import { IconTooltip } from "./IconTooltip";

type Props = {
  mini?: boolean;
  name: string;
  initials: string | null;
  image?: string | null;
  logos?: Array<{ name: string; logo?: string | null }>;
  email?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIntegrations: () => void;
  onSkills: () => void;
  onBoard?: () => void;
  links?: NavLink[];
  onLink?: (link: NavLink) => void;
  onArtifacts: () => void;
  onSettings: (panel: SettingsPanel) => void;
  onUsage: () => void;
  onInvite?: () => void;
  onLogOut: () => void;
  signingOut: boolean;
  logOutError: string | null;
};

// Marks are 24px wide, overlap by 2px, and need 2px for the outer ring.
export function sidebarMarkCount(availableWidth: number) {
  return Math.max(0, Math.min(3, Math.floor((availableWidth - 26) / 22) + 1));
}

export function SidebarFooter({
  mini = false,
  name,
  initials,
  image,
  logos = [],
  email,
  open,
  onOpenChange,
  onIntegrations,
  onSkills,
  onBoard,
  links = [],
  onLink,
  onArtifacts,
  onSettings,
  onUsage,
  onInvite,
  onLogOut,
  signingOut,
  logOutError,
}: Props) {
  const { t } = useLingui();
  const panelLabels = useSettingsPanelLabels();
  const update = useSidebarUpdate();
  // The three panels live one level down from Settings, so the row opens on hover.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsHoverTimer = useRef<number | undefined>(undefined);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [markCount, setMarkCount] = useState(3);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const label = labelRef.current;
    if (!pill || !label || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const style = getComputedStyle(pill);
      const available =
        pill.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight) -
        label.scrollWidth -
        Number.parseFloat(style.columnGap);
      setMarkCount(sidebarMarkCount(available));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    observer.observe(label);
    measure();
    return () => observer.disconnect();
  }, [mini]);
  return (
    <div
      data-testid="sidebar-footer"
      className={`flex shrink-0 items-center gap-2 bg-transparent ${mini ? "flex-col px-1 py-2" : "px-2.5 py-3"}`}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          aria-label={t`Account menu for ${name}`}
          className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          {image && failedImage !== image ? (
            <img
              src={image}
              alt=""
              className="size-full object-cover"
              onError={() => setFailedImage(image)}
            />
          ) : initials ? (
            initials
          ) : (
            <UserRound size={18} aria-hidden="true" />
          )}
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="max-h-(--available-height) w-[295px] max-w-[calc(100vw-69px)] gap-0 overflow-y-auto p-1 *:shrink-0 data-closed:animate-none"
          >
            <div
              data-testid="account-menu-header"
              className="mb-1 min-w-0 border-b border-border px-2.5 py-2.5"
            >
              <p className="truncate text-sm font-medium">{name}</p>
              {email && email !== name ? (
                <p className="truncate text-xs text-muted-foreground">{email}</p>
              ) : null}
            </div>
            {mini ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onIntegrations}
              >
                <Plug className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Connect apps</Trans>
              </Button>
            ) : null}
            <div
              data-testid="account-menu-settings"
              onMouseEnter={() => {
                window.clearTimeout(settingsHoverTimer.current);
                setSettingsOpen(true);
              }}
              onMouseLeave={() => {
                window.clearTimeout(settingsHoverTimer.current);
                settingsHoverTimer.current = window.setTimeout(() => setSettingsOpen(false), 140);
              }}
            >
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                aria-label={t`Settings`}
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <Settings className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Settings</Trans>
                <ChevronRight
                  className={`ms-auto size-3.5 text-muted-foreground transition-transform ${settingsOpen ? "rotate-90" : ""}`}
                  strokeWidth={1.75}
                />
              </Button>
              {settingsOpen ? (
                <div className="ms-4 border-s border-border ps-1.5" data-testid="settings-panels">
                  {SETTINGS_PANELS.map((panel) => (
                    <Button
                      key={panel}
                      variant="ghost"
                      className="h-8 w-full justify-start gap-2 font-normal"
                      data-testid={`settings-panel-${panel}`}
                      onClick={() => {
                        setSettingsOpen(false);
                        onSettings(panel);
                      }}
                    >
                      <span className="text-[13px]">{panelLabels[panel]}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onSkills}
            >
              <ScrollText className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Skills</Trans>
            </Button>
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onArtifacts}
            >
              <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Artifacts</Trans>
            </Button>
            {onBoard ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onBoard}
              >
                <SquareKanban className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Board</Trans>
              </Button>
            ) : null}
            {links.map((link) => (
              <Button
                key={link.id}
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={() => onLink?.(link)}
              >
                <Link2 className="text-muted-foreground" strokeWidth={1.75} />
                {link.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              onClick={onUsage}
            >
              <Gauge className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Usage</Trans>
            </Button>
            <div className="my-1 border-t border-border" />
            {onInvite ? (
              <Button
                variant="ghost"
                className="h-9 w-full justify-start gap-2.5 font-normal"
                onClick={onInvite}
              >
                <UserPlus className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Invite friends</Trans>
              </Button>
            ) : null}
            <a
              className={`${buttonVariants({ variant: "ghost" })} h-9 w-full justify-start gap-2.5 font-normal`}
              href="https://github.com/lostbird1994-debug/livingbot/blob/main/docs/self-host.md"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Docs</Trans>
            </a>
            <div className="my-1 border-t border-border" />
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={onLogOut}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
            {logOutError ? (
              <p role="alert" className="px-2.5 pt-1 pb-2 text-[13px] text-destructive">
                {logOutError}
              </p>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
      {!mini ? (
        <Button
          variant="outline"
          ref={pillRef}
          onClick={onIntegrations}
          className="h-9 min-w-0 flex-1 justify-between bg-sidebar-accent hover:border-foreground/30 hover:bg-sidebar-accent dark:hover:bg-sidebar-accent"
        >
          <span ref={labelRef} className="min-w-0 truncate">
            <Trans>Connect apps</Trans>
          </span>
          <AppMarkStack marks={logos.slice(0, markCount)} ringClassName="ring-sidebar-accent" />
        </Button>
      ) : null}
      {update.available ? (
        <IconTooltip label={t`Install update`}>
          <Button
            size="icon-lg"
            className="rounded-full"
            aria-label={t`Install update`}
            disabled={update.busy}
            onClick={update.install}
          >
            <Download aria-hidden="true" />
          </Button>
        </IconTooltip>
      ) : null}
    </div>
  );
}
