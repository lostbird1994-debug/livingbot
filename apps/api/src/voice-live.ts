import crypto from "node:crypto";
import { dashscopeSocketConstructor } from "@rakazo/adapters";

/**
 * Realtime recognition held inside the API process, for providers whose live protocol the
 * browser cannot speak (Bailian/DashScope: raw WebSocket with an Authorization header and
 * binary PCM frames).
 *
 * The browser still talks to `/api/voice/stream/{start,feed,flush,abort}` with plain JSON, so
 * nothing changes on the client and no local bridge process is needed.
 */
const WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const MODEL = "qwen-audio-3.0-asr-flash-streaming";
const IDLE_MS = 45_000;
const FLUSH_WAIT_MS = 1_600;
const MAX_QUEUED_BYTES = 48_000;
const SAMPLE_RATE = 16_000;

type SocketLike = {
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
};

type Session = {
  id: string;
  owner: string;
  taskId: string;
  socket: SocketLike | null;
  ready: boolean;
  queue: Uint8Array[];
  partial: string;
  finals: string[];
  text: string;
  error: string | null;
  done: boolean;
  lastAt: number;
};

export type LiveSnapshot = {
  partial: string;
  finals: string[];
  ready: boolean;
  done: boolean;
  error: string | null;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDashscopeLiveSessions() {
  const sessions = new Map<string, Session>();

  async function open(apiKey: string, owner: string): Promise<Session> {
    const id = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const session: Session = {
      id,
      owner,
      taskId,
      socket: null,
      ready: false,
      queue: [],
      partial: "",
      finals: [],
      text: "",
      error: null,
      done: false,
      lastAt: Date.now(),
    };
    const Ctor = await dashscopeSocketConstructor();
    const header = (action: string) => ({
      header: { action, task_id: taskId, streaming: "duplex" },
    });
    const send = (payload: unknown) => {
      try {
        session.socket?.send(JSON.stringify(payload));
      } catch {
        session.error = session.error ?? "The recognition socket closed.";
      }
    };

    try {
      session.socket = new Ctor(WS_URL, { headers: { Authorization: `bearer ${apiKey}` } });
    } catch (error) {
      session.error =
        error instanceof Error ? error.message : "Could not open the recognition socket.";
      sessions.set(id, session);
      return session;
    }

    session.socket.addEventListener("open", () => {
      send({
        ...header("run-task"),
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: MODEL,
          parameters: { format: "pcm", sample_rate: SAMPLE_RATE, language_hints: ["zh", "en"] },
          input: {},
        },
      });
    });

    session.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let msg: {
        header?: { event?: string; error_message?: string };
        payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } };
      };
      try {
        msg = JSON.parse(event.data) as typeof msg;
      } catch {
        return;
      }
      const kind = msg.header?.event;
      if (kind === "task-started") {
        session.ready = true;
        for (const chunk of session.queue.splice(0)) {
          try {
            session.socket?.send(chunk);
          } catch {
            session.error = "The recognition socket closed.";
          }
        }
        return;
      }
      if (kind === "task-failed") {
        session.error = msg.header?.error_message || "The recognition task failed.";
        return;
      }
      if (kind === "result-generated") {
        const sentence = msg.payload?.output?.sentence;
        if (!sentence) return;
        const text = sentence.text ?? "";
        if (sentence.sentence_end) {
          const line = text.trim();
          if (line) {
            session.finals.push(line);
            session.text += line;
          }
          session.partial = "";
        } else {
          session.partial = text;
        }
        return;
      }
      if (kind === "task-finished") session.done = true;
    });

    session.socket.addEventListener("error", () => {
      session.error = session.error ?? "The recognition socket failed.";
    });
    session.socket.addEventListener("close", () => {
      if (!session.done) session.error = session.error ?? "The recognition socket disconnected.";
    });

    sessions.set(id, session);
    return session;
  }

  function feedSession(session: Session, pcm: Uint8Array) {
    if (!pcm.length || session.error || session.done) return;
    session.lastAt = Date.now();
    if (!session.ready) {
      session.queue.push(pcm);
      const size = session.queue.reduce((sum, chunk) => sum + chunk.length, 0);
      if (size > MAX_QUEUED_BYTES) {
        session.queue = [];
        session.error = "Recognition could not keep up. Use the complete recording.";
      }
      return;
    }
    try {
      session.socket?.send(pcm);
    } catch {
      session.error = "The recognition socket closed.";
    }
  }

  function close(session: Session) {
    sessions.delete(session.id);
    try {
      session.socket?.close();
    } catch {
      // already closed
    }
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastAt > IDLE_MS) close(session);
    }
  }, 10_000);
  sweeper.unref?.();

  return {
    async start(
      apiKey: string,
      owner: string,
    ): Promise<{ id: string; model: string; error: string | null }> {
      const session = await open(apiKey, owner);
      return { id: session.id, model: MODEL, error: session.error };
    },

    feed(id: string, pcm: Uint8Array, owner: string): LiveSnapshot | null {
      const session = sessions.get(id);
      if (!session || session.owner !== owner) return null;
      feedSession(session, pcm);
      return {
        partial: session.partial,
        finals: session.finals.splice(0),
        ready: session.ready,
        done: session.done,
        error: session.error,
      };
    },

    async flush(id: string, owner: string): Promise<{ text: string; error: string | null } | null> {
      const session = sessions.get(id);
      if (!session || session.owner !== owner) return null;
      // A stop that lands before the handshake finished would send finish-task to a task that
      // does not exist yet, and the service answers by closing the socket. Wait it out instead.
      if (!session.ready && !session.error) {
        const readyBy = Date.now() + 1_200;
        while (Date.now() < readyBy && !session.ready && !session.error) await wait(30);
      }
      try {
        session.socket?.send(
          JSON.stringify({
            header: { action: "finish-task", task_id: session.taskId, streaming: "duplex" },
            payload: { input: {} },
          }),
        );
      } catch {
        session.error = session.error ?? "The recognition socket closed.";
      }
      const deadline = Date.now() + FLUSH_WAIT_MS;
      while (Date.now() < deadline) {
        if (session.done || session.error) break;
        await wait(30);
      }
      const text = session.done ? session.text || session.finals.join("") : "";
      // A socket that closes right after task-finished is the normal end of a session, not a
      // failure; only report an error when nothing was transcribed.
      const error = text
        ? null
        : (session.error ?? (!session.done ? "Recognition timed out." : null));
      close(session);
      return { text, error };
    },

    abort(id: string, owner: string): boolean {
      const session = sessions.get(id);
      if (!session || session.owner !== owner) return false;
      close(session);
      return true;
    },
  };
}
