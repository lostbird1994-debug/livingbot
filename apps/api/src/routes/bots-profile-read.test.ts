import { describe, expect, it, vi } from "vitest";
import type { RouterContext } from "./context.js";
import { botsRoutes } from "./bots.js";

function fixture() {
  const actor = { userId: "user", spaceId: "space" };
  const getBot = vi.fn(async () => ({ id: "bot" }));
  const listBots = vi.fn(async () => [{ id: "bot", name: "Updated" }]);
  const refresh = vi.fn(async () => {});
  const handlers: Record<string, (request: any) => Promise<any>> = {};
  const route = (path = ""): any => new Proxy({}, {
    get: (_target, key) => key === "handler"
      ? (handler: (request: any) => Promise<any>) => { handlers[path] = handler; return handler; }
      : route(path ? `${path}.${String(key)}` : String(key)),
  });
  botsRoutes({
    authed: route(), repos: { getBot, listBots }, deps: { botWorkspace: { refresh } },
  } as unknown as RouterContext);
  return { actor, getBot, listBots, refresh,
    read: () => handlers["bots.get"]!({ context: { actor }, input: { botId: "bot" } }) };
}
describe("single bot profile read", () => {
  it("authorizes and refreshes only the requested bot before reading its public DTO", async () => {
    const f = fixture();
    await expect(f.read()).resolves.toEqual({ id: "bot", name: "Updated" });
    expect(f.getBot).toHaveBeenCalledWith(f.actor, "bot");
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith(f.actor, "bot");
    expect(f.listBots).toHaveBeenCalledExactlyOnceWith(f.actor, { botId: "bot" });
  });
  it("does not touch native files when the bot is outside the caller's scope", async () => {
    const f = fixture();
    f.getBot.mockRejectedValueOnce(Error("not authorized"));
    await expect(f.read()).rejects.toThrow();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.listBots).not.toHaveBeenCalled();
  });
});
