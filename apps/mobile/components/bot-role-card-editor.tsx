import type { BotRoleCard } from "@rakazo/contracts";
import { BOT_ROLE_TEXT_MAX_LENGTH, excludesSharedProfile } from "@rakazo/contracts";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeSwitch } from "./native-switch";

export function BotRoleCardEditor({
  value,
  onChange,
  disabled,
}: {
  value: BotRoleCard;
  onChange: (card: BotRoleCard) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const fields = [
    { key: "identity", title: t("Identity") },
    { key: "personality", title: t("Personality") },
    { key: "userIdentity", title: t("User identity"), toggle: "userIdentityEnabled" },
    { key: "backstory", title: t("Backstory"), toggle: "backstoryEnabled" },
  ] as const;
  return (
    <View style={{ gap: 20 }}>
      {fields.map((field) => (
        <View key={field.key} style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: tokens.mutedForeground, fontSize: 12 }}>
            {field.title}
          </Text>
          <View style={{ borderRadius: 12, backgroundColor: native.fill }}>
            {"toggle" in field ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: 12,
                }}
              >
                <Text style={{ color: tokens.foreground }}>{t("Enabled")}</Text>
                <NativeSwitch
                  accessibilityLabel={field.title}
                  value={value[field.toggle]}
                  disabled={disabled}
                  onValueChange={(checked) => onChange({ ...value, [field.toggle]: checked })}
                />
              </View>
            ) : null}
            <TextInput
              accessibilityLabel={field.title}
              value={value[field.key]}
              multiline
              editable={!disabled}
              style={{
                color: tokens.foreground,
                backgroundColor: native.fill,
                minHeight: 100,
                padding: 12,
                textAlignVertical: "top",
              }}
              maxLength={BOT_ROLE_TEXT_MAX_LENGTH}
              onChangeText={(text) => onChange({ ...value, [field.key]: text })}
            />
          </View>
        </View>
      ))}
      <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
        {excludesSharedProfile(value)
          ? t(
              "Shared USER.md, MEMORY.md and profile.md will not load automatically. Private memory is preserved.",
            )
          : t("User identity and backstory load only when enabled.")}
      </Text>
    </View>
  );
}
