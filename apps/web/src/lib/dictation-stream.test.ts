import { afterEach, expect, it, vi } from "vitest";
import { DictationStream } from "./dictation-stream";

afterEach(() => vi.unstubAllGlobals());

it("captures the short name while the recognition start request is still connecting", async () => {
  let processAudio: ((event: any) => void) | null = null;
  let finishStart: (response: Response) => void = () => undefined;
  const startResponse = new Promise<Response>((resolve) => {
    finishStart = resolve;
  });
  const connect = () => ({ connect: () => undefined, disconnect: () => undefined });
  class Context {
    sampleRate = 16_000;
    state = "running";
    createMediaStreamSource = connect;
    createScriptProcessor() {
      return {
        connect: () => undefined,
        disconnect: () => undefined,
        set onaudioprocess(handler: (event: any) => void) {
          processAudio = handler;
        },
      };
    }
    createGain() {
      return { ...connect(), gain: { value: 0 } };
    }
    close = async () => undefined;
  }
  vi.stubGlobal("AudioContext", Context);
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith("/start")) return startResponse;
    return Promise.resolve(Response.json({ partial: "小雨" }));
  });
  vi.stubGlobal("fetch", fetcher);
  const tap = new DictationStream();
  const started = tap.start({} as MediaStream, new Headers(), vi.fn());
  const samples = new Float32Array(2048).fill(0.25);
  (processAudio as unknown as (event: unknown) => void)({
    inputBuffer: { getChannelData: () => samples },
  });
  expect(fetcher).toHaveBeenCalledOnce();
  finishStart(Response.json({ id: "session" }));
  expect(await started).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  const feed = fetcher.mock.calls.find(([url]) => url.endsWith("/feed"));
  expect(feed).toBeDefined();
  const body = JSON.parse((feed as unknown as [string, RequestInit])[1].body as string);
  expect(Buffer.from(body.pcm, "base64").length).toBe(4096);
  tap.abort();
});
