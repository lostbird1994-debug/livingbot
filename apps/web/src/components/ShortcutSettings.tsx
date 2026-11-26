import { desktopBridge } from "../lib/desktop";
import { isApplePlatform, shortcutGuide } from "../pages/shell/shell-shortcuts";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/**
 * The keys the app answers, listed from the rules that run them. Nothing here is editable yet,
 * and nothing is promised that the app does not handle.
 */
export function ShortcutSettings() {
  const host = { desktop: Boolean(desktopBridge()), apple: isApplePlatform() };
  return (
    <div className="settings-overview" data-testid="shortcut-settings">
      {shortcutGuide(host).map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.rows.map((row) => (
            <SettingsRow
              key={`${group.title}-${row.label}`}
              label={row.label}
              control={
                <kbd className="rounded-md bg-muted px-1.5 py-0.5 text-[12.5px] text-muted-foreground">
                  {row.keys}
                </kbd>
              }
            />
          ))}
        </SettingsGroup>
      ))}
    </div>
  );
}
