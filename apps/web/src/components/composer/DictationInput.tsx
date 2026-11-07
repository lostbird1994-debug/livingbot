import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@rakazo/ui-web";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dictation } from "../../lib/dictation";
import { IconTooltip } from "../IconTooltip";

type Recording = { locked: true; startedAt: number } | null;

/** Dictation only edits the draft. Sending remains a separate user action. */
export function useClickDictation({
  transcribe,
  disabled,
  sessionKey,
  onStart,
  onText,
}: {
  transcribe?: boolean;
  disabled?: boolean;
  sessionKey: string;
  onStart?: () => void;
  onText: (text: string) => void;
}) {
  const { t } = useLingui();
  const [recording, setRecording] = useState<Recording>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const stopping = useRef(false);
  const latest = useRef({ sessionKey, onText, onStart });
  latest.current = { sessionKey, onText, onStart };

  const cancel = useCallback(() => {
    generation.current += 1;
    if (active.current) dictation.stop("cancel");
    active.current = false;
    stopping.current = false;
    setRecording(null);
    setTranscribing(false);
    setTranscript("");
    setNotice(null);
  }, []);

  useEffect(
    () =>
      dictation.subscribe((snapshot) => {
        if (!active.current) return;
        setTranscript(snapshot.transcript);
        setTranscribing(snapshot.status === "transcribing" || stopping.current);
        if (snapshot.status === "idle") {
          active.current = false;
          stopping.current = false;
          setRecording(null);
          setTranscribing(false);
          setNotice(snapshot.error ?? null);
        }
      }),
    [],
  );

  useEffect(() => {
    cancel();
  }, [sessionKey, cancel]);
  useEffect(
    () => () => {
      generation.current += 1;
      if (active.current) dictation.stop("cancel");
      active.current = false;
    },
    [],
  );
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  const submit = useCallback(() => {
    if (!active.current || stopping.current) return;
    stopping.current = true;
    setTranscribing(true);
    dictation.submitHold();
  }, []);

  const toggle = useCallback(() => {
    if (disabled || stopping.current) return;
    if (active.current) {
      submit();
      return;
    }
    const mine = ++generation.current;
    const key = latest.current.sessionKey;
    latest.current.onStart?.();
    active.current = true;
    setNotice(null);
    setTranscript("");
    setRecording({ locked: true, startedAt: Date.now() });
    void dictation
      .listen({
        mode: "hold",
        transcribe,
        onFinal: (text) => {
          if (mine !== generation.current || key !== latest.current.sessionKey) return;
          generation.current += 1;
          active.current = false;
          stopping.current = false;
          setRecording(null);
          setTranscribing(false);
          latest.current.onText(text);
        },
      })
      .catch(() => {
        if (mine !== generation.current || key !== latest.current.sessionKey) return;
        cancel();
        setNotice(t`Could not start dictation. Check microphone permissions.`);
      });
  }, [disabled, submit, transcribe, cancel, t]);

  return { recording, transcribing, transcript, notice, toggle, submit, cancel };
}

type Talk = ReturnType<typeof useClickDictation>;

export function DictationStrip({ talk }: { talk: Talk }) {
  const { t } = useLingui();
  const [now, setNow] = useState(Date.now);
  const since = talk.recording?.startedAt;
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [since]);
  if (since === undefined) return null;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div
      data-testid="dictation-strip"
      className="flex min-h-6 min-w-0 flex-1 items-center gap-2.5 py-0.5 text-sm"
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
      />
      <span className="shrink-0 tabular-nums text-foreground/80">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
      <span
        aria-live="polite"
        dir="auto"
        className={cn("truncate", talk.transcript ? "text-foreground" : "text-muted-foreground")}
      >
        {talk.transcribing
          ? t`Transcribing…`
          : talk.transcript || t`Listening… Click the microphone to finish.`}
      </span>
    </div>
  );
}

export function DictationControls({ talk, disabled }: { talk: Talk; disabled?: boolean }) {
  const { t } = useLingui();
  const recording = talk.recording !== null;
  const label = recording ? t`Finish dictation` : t`Voice input`;
  return (
    <span className="relative inline-flex items-center gap-2">
      {talk.notice && !recording ? (
        <span
          role="alert"
          className="absolute bottom-full end-0 mb-2 w-max max-w-72 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-md"
        >
          {talk.notice}
        </span>
      ) : null}
      {recording ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Cancel dictation`}
          onClick={talk.cancel}
          className="size-8 shrink-0 rounded-full text-muted-foreground"
        >
          <X size={16} />
        </Button>
      ) : null}
      <IconTooltip label={label}>
        <Button
          variant="outline"
          size="icon"
          data-testid="dictation-toggle"
          aria-label={label}
          aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
          aria-pressed={recording}
          disabled={disabled || talk.transcribing}
          onPointerDown={(event) => event.preventDefault()}
          onClick={talk.toggle}
          className={cn(
            "size-8 shrink-0 rounded-full text-foreground/75",
            recording &&
              "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground",
          )}
        >
          {talk.transcribing ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : recording ? (
            <Square size={11} fill="currentColor" />
          ) : (
            <Mic size={16} strokeWidth={1.8} />
          )}
        </Button>
      </IconTooltip>
    </span>
  );
}
