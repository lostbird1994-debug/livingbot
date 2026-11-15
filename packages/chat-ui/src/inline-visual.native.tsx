import type { InlineVisual, WidgetVisual } from "@livingbot/contracts";
import type { ColorTokens, ResolvedAppearance } from "@livingbot/ui-tokens";
import { appearanceColorScheme } from "@livingbot/ui-tokens";
import type { ComponentType, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { inlineVisualSvg, visualCanvas, visualPaint } from "./inline-visual";

export type InlineVisualImageProps = {
  svg: string;
  height: number;
  title: string;
  fallback: ReactNode;
};
export type InlineVisualPickerProps = {
  label: string;
  choices: readonly { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
};
export const InlineVisualImageContext = createContext<ComponentType<InlineVisualImageProps> | null>(
  null,
);
export const InlineVisualPickerContext =
  createContext<ComponentType<InlineVisualPickerProps> | null>(null);
export type InlineWidgetProps = {
  visual: WidgetVisual;
  streaming: boolean;
  palette: ColorTokens;
  colorScheme: ResolvedAppearance;
  fallback: ReactNode;
};
export const InlineWidgetContext = createContext<ComponentType<InlineWidgetProps> | null>(null);

export function InlineVisualNativeView({
  visual,
  palette,
  colorScheme = "light",
  streaming = false,
  fallback,
}: {
  visual: InlineVisual;
  palette: ColorTokens;
  colorScheme?: ResolvedAppearance;
  streaming?: boolean;
  fallback: ReactNode;
}) {
  const Image = useContext(InlineVisualImageContext);
  const Picker = useContext(InlineVisualPickerContext);
  const Widget = useContext(InlineWidgetContext);
  const [step, setStep] = useState(0);
  const scheme = appearanceColorScheme(colorScheme);
  if (visual.kind === "widget")
    return Widget ? (
      <Widget
        visual={visual}
        streaming={streaming}
        palette={palette}
        colorScheme={colorScheme}
        fallback={fallback}
      />
    ) : (
      fallback
    );
  if (visual.kind === "comparison")
    return (
      <View
        style={[styles.frame, { backgroundColor: palette.card, borderColor: palette.border }]}
        accessibilityLabel={visual.description}
      >
        <Text style={[styles.title, { color: palette.foreground }]}>{visual.title}</Text>
        <View style={{ gap: 12 }}>
          {visual.columns.map((column, index) => (
            <View
              key={index}
              style={[
                styles.frame,
                {
                  backgroundColor: visualPaint(
                    column.tone ? `${column.tone}Fill` : "card",
                    palette,
                    scheme,
                  ),
                  borderColor: visualPaint(
                    column.tone ? `${column.tone}Stroke` : "border",
                    palette,
                    scheme,
                  ),
                },
              ]}
            >
              <Text
                style={[
                  styles.title,
                  {
                    color: visualPaint(
                      column.tone ? `${column.tone}Text` : "foreground",
                      palette,
                      scheme,
                    ),
                  },
                ]}
              >
                {column.title}
              </Text>
              {column.subtitle ? (
                <Text style={[styles.body, { color: palette.foreground }]}>{column.subtitle}</Text>
              ) : null}
              {column.items.map((item, itemIndex) => (
                <View key={itemIndex} style={{ marginTop: 8 }}>
                  <Text style={[styles.title, { color: palette.foreground }]}>{item.label}</Text>
                  <Text style={[styles.body, { color: palette.foreground }]}>{item.text}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </View>
    );
  if (!Image || (visual.kind === "steps" && !Picker)) return fallback;
  const canvas = visualCanvas(visual, step);
  const active = visual.kind === "steps" ? (visual.steps[step] ?? visual.steps[0]!) : undefined;
  return (
    <View style={[styles.frame, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <Text style={[styles.title, { color: palette.foreground }]}>{visual.title}</Text>
      {visual.kind === "steps" && Picker ? (
        <Picker
          label={visual.title}
          choices={visual.steps.map((item, index) => ({
            key: String(index),
            label: `${index + 1}. ${item.title}`,
          }))}
          value={String(step)}
          onChange={(key) => {
            const index = Number(key);
            if (Number.isInteger(index) && index >= 0 && index < visual.steps.length)
              setStep(index);
          }}
        />
      ) : null}
      <Image
        svg={inlineVisualSvg(canvas, visual.title, visual.description, palette, scheme)}
        height={canvas.height}
        title={active ? `${visual.title}: ${active.title}` : visual.title}
        fallback={fallback}
      />
      {active?.text ? (
        <Text accessibilityLiveRegion="polite" style={[styles.body, { color: palette.foreground }]}>
          {active.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    marginVertical: 8,
  },
  title: { fontSize: 14, fontWeight: "500", marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 23, marginTop: 8 },
});
