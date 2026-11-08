import * as adapters from "@rakazo/adapters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDashscopeLiveSessions } from "./voice-live.js";

class FakeSocket {
  static instances: FakeSocket[] = [];
  listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  sent: Array<string | Uint8Array> = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  result(text: string, end: boolean) {
    this.emit(
      "message",
      JSON.stringify({
        header: { event: "result-generated" },
        payload: { output: { sentence: { text, sentence_end: end } } },
      }),
    );
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.spyOn(adapters, "dashscopeSocketConstructor").mockResolvedValue(FakeSocket as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("binds live recognition to its user and space, including cancellation", async () => {
  const sessions = createDashscopeLiveSessions();
  const started = await sessions.start("test-key", "owner-space");
  const socket = FakeSocket.instances[0]!;
  expect(socket.options).toEqual({ headers: { Authorization: "bearer test-key" } });
  expect(sessions.feed(started.id, new Uint8Array([1, 2]), "different-space")).toBeNull();
  expect(await sessions.flush(started.id, "different-space")).toBeNull();
  expect(sessions.abort(started.id, "different-user")).toBe(false);
  expect(socket.closed).toBe(false);
  expect(sessions.abort(started.id, "owner-space")).toBe(true);
  expect(socket.closed).toBe(true);
});
it("waits for the finished task, retaining every final sentence", async () => {
  const sessions = createDashscopeLiveSessions();
  const { id } = await sessions.start("test-key", "owner");
  const socket = FakeSocket.instances[0]!;
  socket.emit("open");
  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }));
  socket.result("First sentence.", true);
  sessions.feed(id, new Uint8Array([1, 2]), "owner");
  let settled = false;
  const finishing = sessions.flush(id, "owner").then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(false);
  socket.result("Last sentence.", true);
  socket.emit("message", JSON.stringify({ header: { event: "task-finished" } }));
  await vi.advanceTimersByTimeAsync(30);
  expect(await finishing).toEqual({ text: "First sentence.Last sentence.", error: null });
});
it("falls back to the complete recording instead of returning incomplete text", async () => {
  const sessions = createDashscopeLiveSessions();
  const { id } = await sessions.start("test-key", "owner");
  const socket = FakeSocket.instances[0]!;
  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }));
  socket.result("Only the beginning.", true);
  const finishing = sessions.flush(id, "owner");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await finishing).toMatchObject({ text: "", error: "Recognition timed out." });
});
it("reports queue overflow instead of silently discarding audio", async () => {
  const sessions = createDashscopeLiveSessions();
  const { id } = await sessions.start("test-key", "owner");
  expect(sessions.feed(id, new Uint8Array(48_001), "owner")?.error).toContain("complete recording");
  sessions.abort(id, "owner");
});
