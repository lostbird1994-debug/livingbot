import type { Bot } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Mic, MicOff, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { announcementLine, announcer } from "../../lib/announcer";
import {
  endCall,
  interceptCallWake,
  startCall,
  toggleMute,
  useCallSession,
} from "../../lib/call-session";
import { desktopBridge } from "../../lib/desktop";
import { dictation } from "../../lib/dictation";
import { useSpaceRpc } from "../../lib/space-rpc";
import { speaker } from "../../lib/tts";
import {
  readBotVoicePreferences,
  subscribeVoiceAssistantPrefs,
  voicePreferencesRevision,
} from "../../lib/voice-assistant-pref";
import { type WakeHit, WakeListener } from "../../lib/wake-listener";
import { matchWake } from "../../lib/wake-word";

/** A run that is still the bot's own work; the moment it ends is worth hearing about. */
const ACTIVE_RUN = new Set(["queued", "running", "leased"]);

type Flag = { status: string; preview: string; updatedAt: string; enabled: boolean };

/**
 * The two things a voice assistant does when nobody is talking to it: it listens for its own
 * name, and it says the one message that matters.
 *
 * Mounted once by the shell and rendering almost nothing. The microphone only opens when the
 * user turned the ear on for this device, and it closes the instant a call begins, because the
 * call owns the microphone from then on.
 */
export function VoiceAssistant({
  bots,
  activeBotId,
  transcribe,
  onWake,
}: {
  bots: Bot[];
  /** The bot whose chat is on screen: its own news is not read out while you look at it. */
  activeBotId?: string | null;
  transcribe?: boolean;
  onWake?: (botId: string) => void;
}) {
  const rpc = useSpaceRpc();
  const call = useCallSession();
  const prefsRevision = useSyncExternalStore(
    subscribeVoiceAssistantPrefs,
    voicePreferencesRevision,
    () => 0,
  );
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [restart, setRestart] = useState(0);
  const [shortcutWarning, setShortcutWarning] = useState("");
  const [armed, setArmed] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [heard, setHeard] = useState("");
  const listener = useRef<WakeListener | null>(null);
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const wakeHandler = useRef(onWake);
  wakeHandler.current = onWake;
  const transcribeRef = useRef(transcribe);
  transcribeRef.current = transcribe;
  const activeRef = useRef(active);
  activeRef.current = active;
  const viewing = useRef(activeBotId);
  viewing.current = activeBotId;
  const callRef = useRef(call);
  callRef.current = call;
  const targets = () =>
    botsRef.current
      .filter((bot) => !bot.archivedAt && readBotVoicePreferences(bot.id).wakeEnabled)
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        aliases: readBotVoicePreferences(bot.id).aliases,
      }));
  const enabledIds = bots
    .filter((bot) => !bot.archivedAt && readBotVoicePreferences(bot.id).wakeEnabled)
    .map((bot) => bot.id)
    .join(",");
  const startBot = (hit: WakeHit) => {
    if (!activeRef.current) return;
    const bot = botsRef.current.find((item) => item.id === hit.bot.id);
    if (!bot) return;
    listener.current?.stop();
    setHeard("");
    setTrouble(null);
    startCall({
      botId: bot.id,
      botName: bot.name,
      botColor: bot.color,
      botAvatarSet: bot.avatarSet,
      transcribe: transcribeRef.current,
      instant: true,
      voiceMode: true,
      firstUtterance: hit.rest,
    });
    wakeHandler.current?.(bot.id);
    void desktopBridge()?.voice?.reveal();
  };
  const startBotRef = useRef(startBot);
  startBotRef.current = startBot;
  const command = useRef((_action: "toggle" | "exit" | "mute") => undefined as void);
  command.current = (action) => {
    if (action === "mute") {
      if (callRef.current) toggleMute();
      else setMuted((value) => !value);
      return;
    }
    const next = action === "exit" ? false : !activeRef.current;
    activeRef.current = next;
    if (!next) {
      listener.current?.stop();
      if (callRef.current) endCall();
    }
    setActive(next);
    setMuted(false);
    setHeard("");
    setTrouble(null);
  };

  // The listener outlives renders: it is created once per arming and reads the roster live.
  useEffect(() => {
    if (!active || muted || call || !enabledIds) {
      setArmed(false);
      setHeard("");
      return;
    }
    const ear = new WakeListener();
    listener.current = ear;
    let cancelled = false;
    void ear
      .start(
        {
          onWake: (hit: WakeHit) => {
            if (cancelled) return;
            setArmed(false);
            startBotRef.current(hit);
          },
          onHeard: (text) => {
            if (!cancelled) setHeard(text);
          },
          onError: (message) => {
            if (cancelled) return;
            setTrouble(message);
            setArmed(false);
          },
          onReady: () => {
            if (!cancelled) {
              setArmed(true);
              setTrouble(null);
            }
          },
        },
        targets(),
      )
      .then((started) => {
        if (cancelled) {
          ear.stop();
          return;
        }
        if (!started) setArmed(false);
      });
    return () => {
      cancelled = true;
      ear.stop();
      if (listener.current === ear) listener.current = null;
    };
  }, [active, muted, Boolean(call), enabledIds, restart]);

  // Desktop owns the system shortcut. Never also toggle from the renderer for the same press.
  useEffect(() => {
    const voice = desktopBridge()?.voice;
    let registered = Boolean(voice);
    let cancelled = false;
    const off = voice?.onCommand((action) => command.current(action));
    if (voice)
      void voice
        .connect()
        .then((result) => {
          if (cancelled) return;
          registered = result.registered;
          if (!registered)
            setShortcutWarning(
              "全局快捷键 ⌥ Space 被占用；可在窗口内使用，请关闭冲突的快捷键后重启。",
            );
        })
        .catch(() => {
          if (!cancelled) setShortcutWarning("无法注册全局语音快捷键；请重启桌面应用。");
        });
    else if (desktopBridge())
      setShortcutWarning("当前桌面版本尚不支持全局语音快捷键，需要更新桌面应用。");
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.code !== "Space" || !event.altKey || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      if (!registered) command.current("toggle");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      off?.();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(
    () =>
      interceptCallWake((text, botId) => {
        if (!activeRef.current) return text;
        const hit = matchWake(text, targets());
        if (!hit) return text;
        if (hit.bot.id === botId) return hit.rest;
        startBotRef.current(hit);
        return null;
      }),
    [],
  );

  // Renaming a bot, or creating one, re-aims the ear without re-opening the microphone.
  useEffect(() => {
    listener.current?.setTargets(targets());
  }, [bots, prefsRevision]);

  // Its own voice, the caller's dictation, and a live call all make the microphone useless
  // as ears: anything heard then is the app talking to itself.
  useEffect(() => {
    if (!armed) return;
    let speaking = false;
    let dictating = false;
    const apply = () => listener.current?.setPaused(speaking || dictating || Boolean(call));
    const offSpeaker = speaker.subscribe((snapshot) => {
      speaking = snapshot.status !== "idle";
      apply();
    });
    const offDictation = dictation.subscribe((snapshot) => {
      dictating = snapshot.status === "listening";
      apply();
    });
    return () => {
      offSpeaker();
      offDictation();
    };
  }, [armed, call]);

  useEffect(() => {
    announcer.setBlockedCheck(() => Boolean(callRef.current));
    return () => {
      announcer.clear();
      announcer.setBlockedCheck(() => true);
    };
  }, []);

  const seen = useRef(new Map<string, Flag>());
  const lastObserved = useRef(new Map<string, string | null>());
  const requests = useRef(new Map<string, number>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requests.current.clear();
    };
  }, []);
  useEffect(() => {
    const next = new Map<string, Flag>();
    for (const bot of bots) {
      const enabled = !bot.archivedAt && readBotVoicePreferences(bot.id).notifyEnabled;
      next.set(bot.id, {
        status: bot.status,
        preview: bot.preview,
        updatedAt: bot.updatedAt,
        enabled,
      });
      const previous = seen.current.get(bot.id);
      const prime = !previous?.enabled;
      if (!enabled || (!prime && ACTIVE_RUN.has(bot.status))) continue;
      if (
        !prime &&
        previous.preview === bot.preview &&
        previous.status === bot.status &&
        previous.updatedAt === bot.updatedAt
      )
        continue;
      const allowed = () =>
        readBotVoicePreferences(bot.id).notifyEnabled &&
        !(
          viewing.current === bot.id &&
          document.visibilityState === "visible" &&
          document.hasFocus()
        ) &&
        !callRef.current;
      const request = (requests.current.get(bot.id) ?? 0) + 1;
      requests.current.set(bot.id, request);
      void rpc.threads
        .get({ botId: bot.id })
        .then((snapshot) => {
          if (
            !alive.current ||
            requests.current.get(bot.id) !== request ||
            !readBotVoicePreferences(bot.id).notifyEnabled
          )
            return;
          const message = [...snapshot.messages]
            .reverse()
            .find(
              (message) =>
                message.role === "bot" &&
                !message.id.startsWith("progress:") &&
                !message.id.startsWith("subagent:") &&
                message.blocks.some((block) => block.kind === "text"),
            );
          const hadBaseline = lastObserved.current.has(bot.id);
          const previousId = lastObserved.current.get(bot.id);
          lastObserved.current.set(bot.id, message?.id ?? null);
          if (snapshot.run && ACTIVE_RUN.has(snapshot.run.status)) return;
          if (!message || prime || !hadBaseline || previousId === message.id || !allowed()) return;
          const text = message.blocks
            .filter((block) => block.kind === "text")
            .map((block) => block.text)
            .join("\n\n");
          const line = announcementLine(bot.name, text);
          if (line) announcer.announce(line, bot.id, allowed);
        })
        .catch(() => {
          /* The chat remains authoritative when a notification cannot load. */
        });
    }
    seen.current = next;
  }, [bots, prefsRevision, rpc]);

  const isMuted = call?.muted ?? muted;
  const label = trouble
    ? "语音连接失败"
    : isMuted
      ? "语音已静音"
      : call
        ? `${call.botName} · ${
            {
              ringing: "正在连接",
              listening: "正在听你说",
              thinking: "执行中",
              speaking: "正在回复",
            }[call.phase]
          }`
        : !enabledIds
          ? "尚未启用语音唤醒"
          : armed
            ? "等待呼唤"
            : "正在连接语音";
  const detail =
    trouble ??
    (call?.heard ||
      heard ||
      call?.caption ||
      (!enabledIds ? "到机器人高级页开启“允许语音唤醒”" : "喊机器人名字或别名；⌥ Space 退出"));
  useEffect(() => {
    void desktopBridge()?.voice?.update({ active, label, detail, muted: isMuted });
  }, [active, label, detail, isMuted]);
  useEffect(
    () => () => {
      void desktopBridge()?.voice?.update({ active: false, label: "", detail: "", muted: false });
    },
    [],
  );

  if (!active) return null;

  return (
    <section
      data-testid="voice-wake-armed"
      aria-label="语音模式"
      className="fixed bottom-4 start-4 z-[60] flex max-w-96 items-center gap-3 rounded-2xl border border-border bg-card/95 p-3 shadow-sm backdrop-blur"
    >
      {isMuted ? (
        <MicOff className="size-5 text-muted-foreground" />
      ) : (
        <Mic className="size-5 text-success" />
      )}
      <div className="min-w-0" role="status">
        <p className="truncate text-sm">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
        {shortcutWarning ? <p className="text-xs text-destructive">{shortcutWarning}</p> : null}
      </div>
      {trouble ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setTrouble(null);
            setRestart((value) => value + 1);
          }}
        >
          重试
        </Button>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={isMuted ? "继续语音" : "静音"}
        onClick={() => command.current("mute")}
      >
        {isMuted ? <Mic className="size-4" /> : <MicOff className="size-4" />}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="退出语音模式"
        onClick={() => command.current("exit")}
      >
        <X className="size-4" />
      </Button>
    </section>
  );
}
