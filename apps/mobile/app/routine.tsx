import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineRunHistory } from "../components/routine-run-history";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { routineStatusLine } from "../lib/routine";
import { useBotRoutines } from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function RoutineDetail() {
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const { botId, botName, routineId, origin } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
    origin?: string;
  }>();
  const router = useRouter();
  // Opened from the list, the routine is already known; it still reads again. A routine missing
  // from what was known before only counts as gone once that read answers.
  const {
    routines,
    error: loadError,
    readSinceShown,
    failedSinceShown,
  } = useBotRoutines(botId ?? "", { poll: false });
  const routine = routines?.find((item) => item.id === routineId) ?? null;
  const pending = useRef(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  async function testRun() {
    if (!routine || routine.editable === false || pending.current) return;
    pending.current = true;
    setRunning(true);
    setRunError(null);
    try {
      await rpc("routines/testRun", { routineId: routine.id });
      setHistoryVersion((version) => version + 1);
    } catch (error) {
      setRunError(errorText(error, t("Could not run routine")));
    } finally {
      pending.current = false;
      setRunning(false);
    }
  }
  const error =
    !botId || !routineId
      ? t("Routine link is incomplete")
      : routine
        ? null
        : failedSinceShown
          ? errorText(loadError, t("Could not load routine"))
          : readSinceShown
            ? t("This routine no longer exists")
            : null;
  const loading = !routine && !error;

  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 24, gap: 18 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={glassHeaderOptions(routine?.name ?? t("Routine"))} />
      {loading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
      {routine ? (
        <>
          <View
            style={{
              borderRadius: 16,
              backgroundColor: native.fill,
              padding: 18,
            }}
          >
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
              {[routine.builtinKind ? t("System task") : "", routineStatusLine(routine)]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <View style={{ gap: 8 }}>
            <Text
              style={{ color: tokens.mutedForeground, fontSize: 13, textTransform: "uppercase" }}
            >
              {t("Prompt")}
            </Text>
            <Text
              selectable
              style={{
                color: tokens.foreground,
                fontSize: 15,
                lineHeight: 23,
                borderRadius: 16,
                backgroundColor: native.fill,
                padding: 18,
              }}
            >
              {routine.prompt}
            </Text>
          </View>
          {origin !== "profile" ? (
            <NativeActionButton
              label={t("Open conversation")}
              onPress={() =>
                router.push({
                  pathname: "/thread",
                  params: { botId: botId ?? "", name: botName ?? t("Bot") },
                })
              }
            />
          ) : null}
          <NativeActionButton
            label={running ? t("Running…") : t("Test run")}
            disabled={routine.editable === false}
            busy={running}
            onPress={testRun}
          />
          {runError ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 15 }}>
              {runError}
            </Text>
          ) : null}
          <RoutineRunHistory
            key={`${routine.id}:${historyVersion}`}
            routineId={routine.id}
            botName={botName}
          />
        </>
      ) : null}
    </ScrollView>
  );
}
