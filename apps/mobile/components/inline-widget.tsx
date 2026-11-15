import type { InlineWidgetProps } from "@livingbot/chat-ui/native";
import { InlineVisualReferenceContext } from "@livingbot/chat-ui/native";
import { widgetDocument, widgetShellDocument } from "@livingbot/chat-ui/widget";
import { inlineVisualMarkdown } from "@livingbot/contracts";
import { appearanceColorScheme } from "@livingbot/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { Directory, File, Paths } from "expo-file-system";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Modal, SafeAreaView, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { shareLocalFile } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { NativeActionButton } from "./native-action-button";

/** Trusted outer WebView; all generated scripts run only in its opaque-origin nested iframe. */
export function InlineWidget({ visual, streaming, palette, colorScheme }: InlineWidgetProps) {
  const { t } = useI18n();
  const reference = useContext(InlineVisualReferenceContext);
  const frame = useRef<WebView>(null);
  const exportPending = useRef(false);
  const channel = useId();
  const [loads, setLoads] = useState(0);
  const [height, setHeight] = useState(320);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const document = useMemo(
    () => widgetDocument(visual, palette, appearanceColorScheme(colorScheme), channel, !streaming),
    [visual, palette, colorScheme, channel, streaming],
  );
  const shell = useMemo(() => ({ html: widgetShellDocument(), baseUrl: "about:blank" }), []);
  useEffect(() => {
    if (!loads) return;
    setError(false);
    exportPending.current = false;
    setPendingPrompt("");
    const input = JSON.stringify({ channel, complete: !streaming, document }).replace(
      /</g,
      "\\u003c",
    );
    frame.current?.injectJavaScript(`window.renderLivingBotWidget(${input});true;`);
  }, [loads, channel, streaming, document, expanded]);
  const save = async (image?: string) => {
    try {
      const root = new Directory(Paths.cache, "inline-widgets");
      if (!root.exists) root.create();
      const suffix = image ? "png" : visual.format;
      const name = `${visual.title.replace(/[^\p{L}\p{N}_-]/gu, "_") || "visual"}.${suffix}`;
      const file = new File(root, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
      file.write(
        image
          ? Uint8Array.from(atob(image.slice(image.indexOf(",") + 1)), (c) => c.charCodeAt(0))
          : visual.format === "svg"
            ? visual.code
            : document,
      );
      await shareLocalFile(
        file.uri,
        image ? "image/png" : visual.format === "svg" ? "image/svg+xml" : "text/html",
        name,
      );
    } catch {
      Alert.alert(t("Download"), t("This visual could not render."));
    }
  };
  const image = () => {
    exportPending.current = true;
    frame.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{source:window,data:${JSON.stringify({ channel, type: "export" })}}));true;`,
    );
  };
  const content = (
    <View style={{ gap: 8 }}>
      <Text style={{ color: palette.foreground, fontWeight: "500" }}>{visual.title}</Text>
      {streaming ? (
        <Text style={{ color: palette.mutedForeground }}>
          {visual.loadingMessages?.[0] ?? visual.title}
        </Text>
      ) : null}
      <WebView
        key={expanded ? "expanded" : "inline"}
        ref={frame}
        source={shell}
        style={{ height, backgroundColor: "transparent" }}
        onLoadEnd={() => setLoads((n) => n + 1)}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data?.channel !== channel) return;
            if (data.type === "resize" && Number.isFinite(data.height))
              setHeight(Math.max(80, Math.min(1600, data.height)));
            if (data.type === "error") {
              exportPending.current = false;
              setError(true);
            }
            if (
              data.type === "prompt" &&
              !streaming &&
              typeof data.text === "string" &&
              data.text.length <= 2000
            )
              setPendingPrompt(data.text);
            if (
              data.type === "image" &&
              exportPending.current &&
              typeof data.data === "string" &&
              data.data.length < 16_000_000 &&
              /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(data.data)
            ) {
              exportPending.current = false;
              void save(data.data);
            }
          } catch {
            /* Unknown frame messages do not reach native capabilities. */
          }
        }}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowsLinkPreview={false}
        dataDetectorTypes="none"
        scrollEnabled={height >= 1600}
        onError={() => setError(true)}
        onShouldStartLoadWithRequest={({ url }) =>
          url === "about:blank" || url === "about:blank/" || url === "about:srcdoc"
        }
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: palette.mutedForeground }}>
          {t("This visual could not render.")}
        </Text>
      ) : null}
      {pendingPrompt && reference ? (
        <View>
          <Text style={{ color: palette.foreground }}>{pendingPrompt}</Text>
          <NativeActionButton
            label={t("Add to conversation")}
            prominence="plain"
            onPress={() => {
              reference(pendingPrompt);
              setPendingPrompt("");
            }}
          />
        </View>
      ) : null}
      {!streaming ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {reference ? (
            <NativeActionButton
              label={t("Add to conversation")}
              prominence="plain"
              onPress={() => reference(inlineVisualMarkdown(visual))}
            />
          ) : null}
          <NativeActionButton
            label={expanded ? t("Close") : t("Expand")}
            prominence="plain"
            onPress={() => setExpanded(!expanded)}
          />
          <NativeActionButton
            label={t("Download")}
            prominence="plain"
            onPress={() => void save()}
          />
          <NativeActionButton label={t("Download image")} prominence="plain" onPress={image} />
          <NativeActionButton
            label={t("View source")}
            prominence="plain"
            onPress={() => setSourceOpen((v) => !v)}
          />
        </View>
      ) : null}
      {sourceOpen ? (
        <View>
          <Text selectable style={{ color: palette.foreground, fontFamily: "monospace" }}>
            {visual.code}
          </Text>
          <NativeActionButton
            label={t("Copy code")}
            prominence="plain"
            onPress={() => void Clipboard.setStringAsync(visual.code)}
          />
        </View>
      ) : null}
    </View>
  );
  return expanded ? (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setExpanded(false)}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
        <ScrollView contentContainerStyle={{ padding: 16 }}>{content}</ScrollView>
      </SafeAreaView>
    </Modal>
  ) : (
    content
  );
}
