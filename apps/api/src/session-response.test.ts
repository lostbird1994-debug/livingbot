import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRequestSessions } from "./session-response.js";

describe("HTTP session renewal", () => {
  it("forwards each renewal cookie without joining or replacing route cookies", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "session=renewed; Max-Age=604800; HttpOnly; SameSite=Lax");
    headers.append("set-cookie", "session_data=cache; Expires=Wed, 18 Nov 2026 00:00:00 GMT");
    headers.set("x-private-internal", "not-for-client");
    const lookup = vi.fn(async () => ({ response: { user: { id: "user-1" } }, headers }));
    const sessions = createRequestSessions(lookup);
    const app = new Hono();
    app.use("*", sessions.middleware);
    app.get("/rpc/me", async (c) => {
      const first = await sessions.getSession(c.req.raw);
      expect(await sessions.getSession(c.req.raw)).toBe(first);
      c.header("set-cookie", "route=preserved; HttpOnly");
      return c.json(first);
    });
    const response = await app.request("/rpc/me", { headers: { cookie: "session=original" } });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      "route=preserved; HttpOnly",
      "session=renewed; Max-Age=604800; HttpOnly; SameSite=Lax",
      "session_data=cache; Expires=Wed, 18 Nov 2026 00:00:00 GMT",
    ]);
    expect(response.headers.get("x-private-internal")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      returnHeaders: true,
    });
  });

  it("keeps different requests and accounts isolated", async () => {
    const sessions = createRequestSessions(async ({ headers }) => {
      const id = headers.get("authorization");
      return { response: id, headers: new Headers({ "set-cookie": `session=${id}; HttpOnly` }) };
    });
    const app = new Hono();
    app.use("*", sessions.middleware);
    app.get("/identity", async (c) => c.json(await sessions.getSession(c.req.raw)));
    const [a, b] = await Promise.all([
      app.request("/identity", { headers: { authorization: "account-a" } }),
      app.request("/identity", { headers: { authorization: "account-b" } }),
    ]);
    expect(a.headers.getSetCookie()).toEqual(["session=account-a; HttpOnly"]);
    expect(b.headers.getSetCookie()).toEqual(["session=account-b; HttpOnly"]);
    expect(await a.json()).toBe("account-a");
    expect(await b.json()).toBe("account-b");
  });

  it("preserves expiration cookies when the session is rejected", async () => {
    const sessions = createRequestSessions(async () => ({
      response: null,
      headers: new Headers({ "set-cookie": "session=; Max-Age=0; HttpOnly" }),
    }));
    const app = new Hono();
    app.use("*", sessions.middleware);
    app.get("/rpc/me", async (c) => {
      await sessions.getSession(c.req.raw);
      return c.json({ error: "unauthorized" }, 401);
    });
    const response = await app.request("/rpc/me");
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual(["session=; Max-Age=0; HttpOnly"]);
  });

  it("does not look up sessions or change cookies on public and sign-out routes", async () => {
    const lookup = vi.fn(async () => ({ response: null, headers: new Headers() }));
    const sessions = createRequestSessions(lookup);
    const app = new Hono();
    app.use("*", sessions.middleware);
    app.get("/health", (c) => c.json({ ok: true }));
    app.post("/api/auth/sign-out", (c) => {
      c.header("set-cookie", "session=; Max-Age=0; HttpOnly");
      return c.json({ ok: true });
    });
    expect((await app.request("/health")).headers.getSetCookie()).toEqual([]);
    expect((await app.request("/api/auth/sign-out", { method: "POST" })).headers.getSetCookie())
      .toEqual(["session=; Max-Age=0; HttpOnly"]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("forwards renewal without waiting for an event stream to finish", async () => {
    const sessions = createRequestSessions(async () => ({
      response: { user: { id: "user-1" } },
      headers: new Headers({ "set-cookie": "session=renewed; HttpOnly" }),
    }));
    const cancelled = vi.fn();
    const app = new Hono();
    app.use("*", sessions.middleware);
    app.get("/rpc/events", async (c) => {
      await sessions.getSession(c.req.raw);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: progress\n\n"));
        },
        cancel: cancelled,
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const response = await app.request("/rpc/events");
    expect(response.headers.getSetCookie()).toEqual(["session=renewed; HttpOnly"]);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("data: progress\n\n");
    await reader.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
