import { afterEach, describe, expect, it, vi } from "vitest";

function stubStorage(store = new Map<string, string>()) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
  return store;
}

describe("connector scope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("carries the choice made in one session into the next", async () => {
    stubStorage();
    const first = await import("./connector-scope");
    first.writeConnectorScope("task:bot:one", ["feishu-cli"]);

    // A fresh page load forgets the module map and rebuilds it from storage.
    vi.resetModules();
    const next = await import("./connector-scope");
    expect(next.readConnectorScope("task:bot:two")).toEqual(["feishu-cli"]);
  });

  it("keeps a session's own choice apart from the next session's", async () => {
    stubStorage();
    const scope = await import("./connector-scope");
    scope.writeConnectorScope("task:bot:one", ["feishu-cli"]);
    expect(scope.readConnectorScope("task:bot:two")).toEqual(["feishu-cli"]);

    scope.writeConnectorScope("task:bot:two", ["tencent-ima"]);
    expect(scope.readConnectorScope("task:bot:one")).toEqual(["feishu-cli"]);
  });

  it("remembers turning every connector off", async () => {
    stubStorage();
    const scope = await import("./connector-scope");
    scope.writeConnectorScope("task:bot:one", ["feishu-cli"]);
    scope.writeConnectorScope("task:bot:one", []);

    vi.resetModules();
    const next = await import("./connector-scope");
    expect(next.readConnectorScope("task:bot:two")).toEqual([]);
  });

  it("loads a selection saved before the choice outlived a send", async () => {
    stubStorage(new Map([["rakazo.taskConnectorScope.task:bot:one", '["feishu-cli"]']]));
    const scope = await import("./connector-scope");
    expect(scope.readConnectorScope("task:bot:one")).toEqual(["feishu-cli"]);
  });
});
