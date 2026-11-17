import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const describeFast = process.env.VERIFY_PROVIDERS ? describe.skip : describe;
const repoRoot = path.resolve(import.meta.dirname, "../../..");

describeFast("compose installer smoke scripts", () => {
  // This runs nine shell suites; concurrent full-suite runs also contend for process startup.
  it("passes every infra/compose/*.smoke.sh", { timeout: 120_000 }, () => {
    const runner = path.resolve(repoRoot, "infra/compose/run-smokes.sh");
    const result = spawnSync("bash", [runner], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
      timeout: 110_000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(result.stdout).toMatch(/==>/);
  });
});
