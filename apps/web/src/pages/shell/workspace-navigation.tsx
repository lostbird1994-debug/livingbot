import { Button } from "@livingbot/ui-web";
import { ClipboardList, FileText, LayoutGrid, MessageCircle, Wrench } from "lucide-react";

export type WorkspaceView = "bots" | "groups" | "tasks" | "deliveries" | "abilities";

export function workspaceView(value: string | null): WorkspaceView | null {
  return value === "bots" ||
    value === "groups" ||
    value === "tasks" ||
    value === "deliveries" ||
    value === "abilities"
    ? value
    : null;
}

const destinations = [
  { id: "bots", label: "广场", icon: LayoutGrid },
  { id: "groups", label: "群聊", icon: MessageCircle },
  { id: "tasks", label: "任务", icon: ClipboardList },
  { id: "deliveries", label: "产出", icon: FileText },
  { id: "abilities", label: "共享能力", icon: Wrench },
] as const;

export function WorkspaceNavigation({
  view,
  mini,
  settingsOpen,
  onNavigate,
}: {
  view: WorkspaceView | null;
  mini: boolean;
  settingsOpen: boolean;
  onNavigate: (view: WorkspaceView) => void;
}) {
  return (
    <nav aria-label="工作室" className="flex shrink-0 flex-col gap-0.5 px-3 pb-2">
      {destinations.map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          variant="ghost"
          title={mini ? label : undefined}
          aria-label={label}
          aria-current={!settingsOpen && view === id ? "page" : undefined}
          onClick={() => onNavigate(id)}
          className={`h-9 gap-3 rounded-xl px-3 font-normal ${mini ? "justify-center" : "justify-start"} ${
            !settingsOpen && view === id
              ? "bg-background text-foreground shadow-sm ring-1 ring-border/50 aria-current:bg-background"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
          {!mini ? label : null}
        </Button>
      ))}
    </nav>
  );
}
