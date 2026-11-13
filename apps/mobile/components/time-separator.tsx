import { formatTimeSeparator } from "@livingbot/core";
import { typeScale } from "@livingbot/ui-tokens";
import { Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi, useI18n } from "../lib/i18n";

export function TimeSeparator({ createdAt }: { createdAt?: string }) {
  const { locale, t } = useI18n();
  if (!createdAt) return null;
  return (
    <Text
      accessibilityRole="header"
      selectable={false}
      style={{
        color: mobileTokens().faintForeground,
        ...typeScale.caption,
        textAlign: "center",
        marginVertical: 12,
      }}
    >
      {formatTimeSeparator(createdAt, dateLocaleForUi(locale), {
        today: t("Today"),
        yesterday: t("Yesterday"),
      })}
    </Text>
  );
}
