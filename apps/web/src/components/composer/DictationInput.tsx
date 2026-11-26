import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@livingbot/ui-web";
import { LoaderCircle, Mic } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dictation } from "../../lib/dictation";
import { IconTooltip } from "../IconTooltip";

type Recording = { locked: true; startedAt: number } | null;

/** After the tap stops, give the recognizer this long to hand back a transcript. */
const STOP_WATCHDOG_MS = 20_000;

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
  /** Cleared on any hand-back: a transcription that never answers must not wedge the bar. */
  const stoppingTimer = useRef(0);
  const latest = useRef({ sessionKey, onText, onStart });
  latest.current = { sessionKey, onText, onStart };

  const cancel = useCallback(() => {
    window.clearTimeout(stoppingTimer.current);
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
          window.clearTimeout(stoppingTimer.current);
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
      window.clearTimeout(stoppingTimer.current);
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
    // The recognizer owns its own timeout; this only guarantees the bar comes back even when
    // that reply is lost, so a stalled transcription cannot leave the microphone disabled.
    window.clearTimeout(stoppingTimer.current);
    stoppingTimer.current = window.setTimeout(() => {
      if (stopping.current) cancel();
    }, STOP_WATCHDOG_MS);
  }, [cancel]);

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
          : talk.transcript || t`Listening… Click the bars to finish.`}
      </span>
    </div>
  );
}

/** One bar per strand; the shared CSS animation staggers them into a voice wave. */
function RecordingWave() {
  return (
    <span aria-hidden="true" className="flex h-3.5 items-center justify-center gap-[2px]">
      {[0, 1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          className="rk-dictation-bar h-full w-[2px] rounded-full bg-current"
          style={{ animationDelay: `${bar * 110}ms` }}
        />
      ))}
    </span>
  );
}

export function DictationControls({ talk, disabled }: { talk: Talk; disabled?: boolean }) {
  const { t } = useLingui();
  const recording = talk.recording !== null;
  const label = recording ? t`Finish dictation` : t`Voice input`;
  return (
    <span className="relative inline-flex items-center">
      {talk.notice && !recording ? (
        <span
          role="alert"
          className="absolute bottom-full end-0 mb-2 w-max max-w-72 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground shadow-md"
        >
          {talk.notice}
        </span>
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
              "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
          )}
        >
          {talk.transcribing ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : recording ? (
            <RecordingWave />
          ) : (
            <Mic size={16} strokeWidth={1.8} />
          )}
        </Button>
      </IconTooltip>
    </span>
  );
}
