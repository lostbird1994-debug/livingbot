import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WakeListener } from "./wake-listener";

const fake = vi.hoisted(() => ({
  onText: null as null | ((text: string) => void),
  start: vi.fn(),
  finish: vi.fn(),
  abort: vi.fn(),
  trackStop: vi.fn(),
  sample: 128,
}));
vi.mock("./dictation-stream", () => ({
  DictationStream: class {
    start = fake.start;
    finish = fake.finish;
    abort = fake.abort;
  },
}));
vi.mock("./rpc", () => ({ selectedSpaceId: () => "space", withSpaceHeaders: () => new Headers() }));
const listeners: WakeListener[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  fake.sample = 128;
  vi.useFakeTimers();
  fake.start.mockImplementation(async (_stream, _headers, onText, _onFailure) => {
    fake.onText = onText;
    return true;
  });
  fake.finish.mockResolvedValue("");
  const stream = {
    getTracks: () => [{ stop: fake.trackStop }],
    getAudioTracks: () => [{ addEventListener: vi.fn() }],
  };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  class Context {
    state = "running";
    createMediaStreamSource() {
      return { connect: vi.fn() };
    }
    createAnalyser() {
      return {
        fftSize: 1024,
        getByteTimeDomainData: (samples: Uint8Array) => samples.fill(fake.sample),
      };
    }
    close = async () => undefined;
  }
  vi.stubGlobal("AudioContext", Context);
});
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function listener() {
  const value = new WakeListener();
  listeners.push(value);
  return value;
}

it("opens recognition before speech and stays armed through silence and an unmatched phrase", async () => {
  const ear = listener(),
    onWake = vi.fn();
  await ear.start({ onWake }, [{ id: "a", name: "小雨" }]);
  expect(fake.start).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(ear.isRunning).toBe(true);
  fake.onText?.("今天天气不错");
  fake.finish.mockResolvedValueOnce("今天天气不错");
  await vi.advanceTimersByTimeAsync(800);
  expect(onWake).not.toHaveBeenCalled();
  expect(fake.start).toHaveBeenCalledTimes(2);
  expect(ear.isRunning).toBe(true);
});

it("waits for the final utterance so the command after the name is retained", async () => {
  const ear = listener(),
    onWake = vi.fn();
  await ear.start({ onWake }, [{ id: "a", name: "小雨" }]);
  fake.onText?.("小雨");
  expect(onWake).not.toHaveBeenCalled();
  fake.onText?.("小雨帮我查邮件");
  fake.finish.mockResolvedValueOnce("小雨，帮我查邮件");
  await vi.advanceTimersByTimeAsync(800);
  expect(onWake).toHaveBeenCalledWith(
    expect.objectContaining({ bot: { id: "a", name: "小雨" }, rest: "帮我查邮件" }),
  );
  expect(ear.isRunning).toBe(false);
  expect(fake.trackStop).toHaveBeenCalled();
});

it("does not open a delayed microphone after exiting mode", async () => {
  let permission: (stream: unknown) => void = () => undefined;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(
    new Promise((resolve) => {
      permission = resolve as never;
    }),
  );
  const ear = listener();
  const starting = ear.start({ onWake: vi.fn() }, [{ id: "a", name: "小雨" }]);
  ear.stop();
  permission({ getTracks: () => [{ stop: fake.trackStop }] });
  expect(await starting).toBe(false);
  expect(fake.trackStop).toHaveBeenCalledOnce();
  expect(fake.start).not.toHaveBeenCalled();
});

it("flushes a lone name even when the recognizer sends no partial", async () => {
  const ear = listener(),
    onWake = vi.fn();
  await ear.start({ onWake }, [{ id: "a", name: "小雨" }]);
  fake.sample = 132;
  await vi.advanceTimersByTimeAsync(200);
  fake.sample = 128;
  fake.finish.mockResolvedValueOnce("小雨");
  await vi.advanceTimersByTimeAsync(1_400);
  expect(onWake).toHaveBeenCalledWith(expect.objectContaining({ rest: "" }));
});
