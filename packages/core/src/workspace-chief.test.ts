import { describe, expect, it } from "vitest";
import { findWorkspaceChief } from "./workspace-chief.js";

describe("workspace Chief identity", () => {
  it("keeps a renamed onboarding Chief ahead of a namesake", () => {
    const renamed = { name: "Renamed steward", spawnKey: "onboarding:first" };
    expect(findWorkspaceChief([{ name: "Chief", spawnKey: null }, renamed])).toBe(renamed);
  });
  it("supports one legacy Chief but never guesses between namesakes", () => {
    const legacy = { name: "Chief", spawnKey: null };
    expect(findWorkspaceChief([legacy])).toBe(legacy);
    expect(findWorkspaceChief([legacy, { ...legacy }])).toBeUndefined();
    expect(findWorkspaceChief([{ name: "Assistant", spawnKey: null }])).toBeUndefined();
  });
});
