import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface TurnSnapshot {
  available: boolean;
  complete: boolean;
  speechProbability: number;
  silenceMs: number;
}

/** Optional local inference boundary. No audio is persisted, and each stream owns its state. */
export function createLocalTurnDetector(signal?: AbortSignal) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let loading: Promise<void> | undefined;
  let nextId = 0;
  let retryAt = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: TurnSnapshot | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const settle = () => {
    child = undefined;
    retryAt = Date.now() + 30_000;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    pending.clear();
  };
  signal?.addEventListener(
    "abort",
    () => {
      child?.kill();
      settle();
    },
    { once: true },
  );
  const load = async () => {
    if (signal?.aborted || child || Date.now() < retryAt) return;
    try {
      const config = JSON.parse(
        await readFile(join(process.env.DATA_DIR ?? "./data", "voice-turn", "config.json"), "utf8"),
      ) as { command: string[] };
      if (
        !Array.isArray(config.command) ||
        !config.command.length ||
        !config.command.every((value) => typeof value === "string" && value.length > 0)
      )
        throw new Error("Invalid turn detector command");
      if (signal?.aborted) return;
      const proc = spawn(config.command[0]!, config.command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      child = proc;
      proc.unref();
      // Never expose inference output, audio or private runtime paths in logs.
      proc.stderr.resume();
      const failed = () => {
        if (child === proc) settle();
      };
      proc.on("error", failed);
      proc.on("exit", failed);
      proc.stdin.on("error", failed);
      createInterface({ input: proc.stdout }).on("line", (line) => {
        try {
          const result = JSON.parse(line);
          const entry = pending.get(result.id);
          if (!entry) return;
          pending.delete(result.id);
          clearTimeout(entry.timer);
          entry.resolve(
            typeof result.complete === "boolean" &&
              Number.isFinite(result.speechProbability) &&
              Number.isFinite(result.silenceMs)
              ? {
                  available: true,
                  complete: result.complete,
                  speechProbability: result.speechProbability,
                  silenceMs: result.silenceMs,
                }
              : null,
          );
        } catch {
          /* A malformed reply falls back to the caller's silence window. */
        }
      });
    } catch {
      retryAt = Date.now() + 30_000;
    }
  };
  return {
    async feed(session: string, pcm: Uint8Array): Promise<TurnSnapshot | null> {
      if (!loading)
        loading = load().finally(() => {
          loading = undefined;
        });
      await loading;
      const proc = child;
      if (!proc || pending.size >= 100) return null;
      const id = ++nextId;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
          if (child === proc) {
            proc.kill();
            settle();
          }
        }, 1500);
        pending.set(id, { resolve, timer });
        proc.stdin.write(
          JSON.stringify({
            id,
            session,
            pcm: Buffer.from(pcm).toString("base64"),
          }) + "\n",
          (error) => {
            if (!error) return;
            const entry = pending.get(id);
            pending.delete(id);
            clearTimeout(timer);
            entry?.resolve(null);
          },
        );
      });
    },
    close(session: string) {
      child?.stdin.write(JSON.stringify({ close: session }) + "\n");
    },
  };
}
