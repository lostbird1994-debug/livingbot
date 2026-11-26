import type { ReactNode } from "react";
import "./settings-rows.css";

export const SETTINGS_CONTENT_WIDTH = "w-full min-w-0";

/** A labeled list of settings rows sharing one white surface. */
export function SettingsGroup({
  title,
  children,
  "data-testid": testId,
}: {
  title?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section className="settings-group" data-testid={testId}>
      {title ? <h3 className="settings-group__label">{title}</h3> : null}
      <div className="settings-card">{children}</div>
    </section>
  );
}

/**
 * One setting: label and a line of context on the left, its control on the right.
 * Detail with its own layout (a picker, a list) goes in children, below both.
 */
export function SettingsRow({
  label,
  description,
  control,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const solo = description || children ? "" : " settings-row--solo";
  return (
    <div className={`settings-row${solo}`}>
      <div className="settings-row__main">
        <div className="settings-row__copy">
          <p className="settings-row__label">{label}</p>
          {description ? <p className="settings-row__desc">{description}</p> : null}
        </div>
        {control ? <div className="settings-row__control">{control}</div> : null}
      </div>
      {children ? <div className="settings-row__body">{children}</div> : null}
    </div>
  );
}
