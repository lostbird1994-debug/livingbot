import type { InlineVisual } from "@livingbot/contracts";
import { appearanceColorScheme, webTokensForAppearance } from "@livingbot/ui-tokens";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  NativeSelect,
  NativeSelectOption,
} from "@livingbot/ui-web";
import { useEffect, useState } from "react";
import { inlineVisualSvg, visualCanvas, visualPaint } from "./inline-visual";
import { useMarkdownCopy } from "./markdown-copy";
import { useChatAppearance } from "./mermaid.web";
import { WidgetView } from "./widget.web";

export function InlineVisualView({ visual, source }: { visual: InlineVisual; source: string }) {
  const copy = useMarkdownCopy();
  const appearance = useChatAppearance();
  const [step, setStep] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (visual.kind === "widget") return <WidgetView visual={visual} />;
  const palette = webTokensForAppearance(appearance);
  const scheme = appearanceColorScheme(appearance);
  const canvas = visual.kind === "comparison" ? undefined : visualCanvas(visual, step);
  const svg = canvas
    ? inlineVisualSvg(canvas, visual.title, visual.description, palette, scheme)
    : undefined;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg ?? "")}`;
  const activeStep = visual.kind === "steps" ? (visual.steps[step] ?? visual.steps[0]!) : undefined;
  const content = (large = false) =>
    visual.kind === "comparison" ? (
      <div className="rk-inline-comparison" aria-label={visual.description}>
        {visual.columns.map((column, index) => (
          <section
            key={index}
            className="rk-inline-comparison-column"
            style={{
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
              color: visualPaint(
                column.tone ? `${column.tone}Text` : "foreground",
                palette,
                scheme,
              ),
            }}
          >
            <h3>{column.title}</h3>
            {column.subtitle ? <p>{column.subtitle}</p> : null}
            <dl>
              {column.items.map((item, itemIndex) => (
                <div key={itemIndex}>
                  <dt>{item.label}</dt>
                  <dd>{item.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    ) : (
      <>
        {visual.kind === "steps" ? (
          <NativeSelect
            aria-label={visual.title}
            value={step}
            onChange={(event) => setStep(Number(event.target.value))}
          >
            {visual.steps.map((item, index) => (
              <NativeSelectOption
                key={index}
                value={index}
              >{`${index + 1}. ${item.title}`}</NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: This horizontal scroll region must be keyboard reachable. */}
        <section className="rk-inline-visual-scroll" tabIndex={0} aria-label={visual.title}>
          <img
            src={src}
            alt={activeStep ? `${visual.title}: ${activeStep.title}` : visual.title}
            width={680}
            height={canvas!.height}
            className={
              large ? "rk-inline-visual-image rk-inline-visual-large" : "rk-inline-visual-image"
            }
          />
        </section>
        {activeStep?.text ? <p aria-live="polite">{activeStep.text}</p> : null}
      </>
    );
  return (
    <figure className="rk-inline-visual" data-testid="inline-visual">
      <figcaption>{visual.title}</figcaption>
      {content()}
      <div className="rk-inline-visual-actions">
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          {copy.expandDiagram}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigator.clipboard
              ?.writeText(source)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? copy.copied : copy.copyDiagramSource}
        </Button>
        {svg ? (
          <a download="diagram.svg" href={src}>
            {copy.downloadSvg}
          </a>
        ) : null}
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-4xl">
          <DialogTitle>{visual.title}</DialogTitle>
          {content(true)}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
