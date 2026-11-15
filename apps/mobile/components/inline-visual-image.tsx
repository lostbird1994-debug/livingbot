import type { InlineVisualImageProps } from "@livingbot/chat-ui/native";
import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

/** Only markup generated from validated primitives, never model-supplied HTML or scripts. */
export function InlineVisualImage({ svg, height, title, fallback }: InlineVisualImageProps) {
  const [failed, setFailed] = useState<string>();
  if (failed === svg) return fallback;
  const html = `<!doctype html><meta name="viewport" content="width=680"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;background:transparent}</style>${svg}`;
  return (
    <ScrollView
      horizontal
      accessibilityRole="image"
      accessibilityLabel={title}
      style={styles.scroll}
    >
      <WebView
        source={{ html, baseUrl: "about:blank" }}
        style={{ width: 680, height, backgroundColor: "transparent" }}
        onError={() => setFailed(svg)}
        onHttpError={() => setFailed(svg)}
        javaScriptEnabled={false}
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
        scrollEnabled={false}
        onShouldStartLoadWithRequest={({ url }) => url === "about:blank" || url === "about:blank/"}
      />
    </ScrollView>
  );
}
const styles = StyleSheet.create({ scroll: { width: "100%" } });
