import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechFeed, stableSpeechPrefix, VoicePlayback } from "./voice-playback.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streaming reply text", () => {
  it("schedules continuous audio and discards late chunks after interruption", async () => {
    const starts: number[] = [];
    const stops = vi.fn();
    class Context {
      currentTime = 1;
      state = "running";
      destination = {};
      close = vi.fn(async () => undefined);
      createBuffer(_channels: number, length: number, rate: number) {
        return { duration: length / rate, getChannelData: () => new Float32Array(length) };
      }
      createBufferSource() {
        return {
          buffer: null,
          onended: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: (at: number) => starts.push(at),
          stop: stops,
        };
      }
    }
    vi.stubGlobal("AudioContext", Context);
    let live = true;
    const playback = new VoicePlayback(
      () => live,
      () => {},
    );
    await playback.push(new Uint8Array(1024), 16000, 1, "第一句。");
    await playback.push(new Uint8Array(1024), 16000, 1, "第一句。");
    expect(starts).toEqual([1.5, 1.532]);
    live = false;
    playback.stop();
    await playback.push(new Uint8Array(1024), 16000, 2, "不应播放。");
    expect(starts).toHaveLength(2);
    expect(stops).toHaveBeenCalledTimes(2);
  });
  it("holds unfinished sentences and open quotes while releasing a stable Chinese prefix", () => {
    expect(stableSpeechPrefix("已经检查完。还有一")).toBe("已经检查完。");
    expect(stableSpeechPrefix("他说“请稍等。")).toBe("");
    expect(stableSpeechPrefix("已经检查完。还有一", true)).toBe("已经检查完。还有一");
  });
  it("does not synthesize unfinished code blocks", () => {
    expect(stableSpeechPrefix("完成了。\n```ts\nconst name = 'test.'")).toBe("完成了。");
  });
  it("delivers appended text in order, including a close while waiting", async () => {
    const feed = createSpeechFeed();
    const iterator = feed[Symbol.asyncIterator]();
    const first = iterator.next();
    feed.append("第一句。");
    expect(await first).toEqual({ value: "第一句。", done: false });
    feed.append("第二句。");
    feed.close();
    expect(await iterator.next()).toEqual({ value: "第二句。", done: false });
    expect((await iterator.next()).done).toBe(true);
    feed.append("不能复活。");
    expect((await iterator.next()).done).toBe(true);
  });
});
