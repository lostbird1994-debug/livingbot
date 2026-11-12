import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../../../packages/auth/src/index.js";
import { createRequestSessions } from "./session-response.js";

// Real session routing and signing; the official offline adapter replaces storage.
vi.mock("../../../packages/auth/node_modules/better-auth/dist/adapters/prisma-adapter/index.mjs", async () => {
  const { memoryAdapter } = await import("../../../packages/auth/node_modules/better-auth/dist/adapters/memory-adapter/index.mjs") as unknown as {
    memoryAdapter: (data: Record<string, object[]>) => unknown;
  };
  return { prismaAdapter: (prisma: { authData: Record<string, object[]> }) => memoryAdapter(prisma.authData) };
});

describe("real session renewal", () => {
  it.each(["cookie", "bearer"])("renews the stored session and HTTP credentials for %s", async (mode) => {
    const now = Date.now();
    const oldExpiry = now + 5 * 24 * 60 * 60 * 1000;
    const token = "offline-session-token";
    const user = {
      id: "user-offline", email: "test@example.test", name: "Test",
      emailVerified: true, createdAt: new Date(now), updatedAt: new Date(now),
    };
    const data = {
      user: [user], account: [], verification: [], passkey: [],
      session: [{
        id: "session-offline", userId: user.id, token,
        createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(oldExpiry),
      }],
    };
    const auth = createAuth({ authData: data } as never, {
      secret: "offline-session-renewal-secret-at-least-32-chars",
      baseURL: "http://app.example.test",
      webOrigin: "http://app.example.test",
      signupsEnabled: "false", signupAllowlist: "",
    });
    const context = await auth.$context;
    const signature = createHmac("sha256", context.secret).update(token).digest("base64");
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
    const headers = new Headers();
    headers.set(mode === "cookie" ? "cookie" : "authorization",
      mode === "cookie" ? cookie : `Bearer ${token}.${signature}`);
    const sessions = createRequestSessions((input) => auth.api.getSession(input));
    const app = new Hono();
    app.use("*", sessions.middleware);
    app.get("/rpc/me", async (c) => c.json((await sessions.getSession(c.req.raw))?.user.id));
    const response = await app.request("/rpc/me", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(user.id);
    const renewed = response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="));
    expect(renewed).toContain("Max-Age=604800");
    expect(renewed).toContain("HttpOnly");
    expect(new Date(data.session[0]!.expiresAt).getTime()).toBeGreaterThan(oldExpiry);
    const next = await app.request("/rpc/me", { headers });
    expect(next.status).toBe(200);
    expect(next.headers.getSetCookie().some(value => value.includes("Max-Age=0"))).toBe(false);
  });
});
