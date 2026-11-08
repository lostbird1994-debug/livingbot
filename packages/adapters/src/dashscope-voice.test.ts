import { afterEach, expect, it, vi } from "vitest";
import { DashScopeVoiceProvider, dashscopeSocketConstructor } from "./dashscope-voice.js";

const sockets = vi.hoisted(() => ({
  instances: [] as Array<{
    options: unknown;
    sent: unknown[];
    closed: boolean;
    emit: (type: string, data?: unknown) => void;
  }>,
}));
vi.mock("ws", () => ({
  WebSocket: class {
    listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    sent: unknown[] = [];
    closed = false;
    constructor(
      _url: string,
      readonly options: unknown,
    ) {
      sockets.instances.push(this);
    }
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(data: unknown) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
    }
    emit(type: string, data?: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener({ data });
    }
  },
}));
afterEach(() => {
  sockets.instances = [];
  vi.restoreAllMocks();
});
const context = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

it("loads an authenticated Node socket only when voice is used", async () => {
  expect(sockets.instances).toHaveLength(0);
  const Ctor = await dashscopeSocketConstructor();
  new Ctor("wss://example.invalid", { headers: { Authorization: "bearer test-key" } });
  expect(sockets.instances[0]?.options).toEqual({ headers: { Authorization: "bearer test-key" } });
});
it("returns cloud synthesis as a complete WAV and advertises cross-platform synthesis", async () => {
  const provider = new DashScopeVoiceProvider();
  expect(provider.describe().capabilities.synthesize).toBe(true);
  const pending = provider.synthesize(
    { text: "Example", voiceId: "longanhuan_v3.1", apiKey: "test-key" },
    context,
  );
  await vi.waitFor(() => expect(sockets.instances).toHaveLength(1));
  const socket = sockets.instances[0]!;
  socket.emit("open");
  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }));
  socket.emit("message", new Uint8Array([1, 2, 3, 4]));
  socket.emit("message", JSON.stringify({ header: { event: "task-finished" } }));
  const clip = await pending;
  expect(clip.mimeType).toBe("audio/wav");
  expect(Buffer.from(clip.bytes).subarray(0, 4).toString()).toBe("RIFF");
  expect(Buffer.from(clip.bytes).subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(socket.closed).toBe(true);
});
