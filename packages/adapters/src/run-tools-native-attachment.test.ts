import { expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { fileTools } from "./run-tools-files.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import { publishMessage } from "./run-messages.js";

vi.mock("./thread-artifacts.js", () => ({ attachWorkspaceFileToThread: vi.fn() }));
vi.mock("./run-messages.js", () => ({ publishMessage: vi.fn(), persistMessageInTransaction: vi.fn() }));
vi.mock("./run-tools-computer.js", () => ({ recordComputerAction: vi.fn() }));

it("publishes native-workspace bytes through the existing persistent conversation attachment path", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const nativeWorkspaceFile = vi.fn(async () => bytes);
  const computer = vi.fn();
  const sandboxRead = vi.fn();
  const context = { spaceId: "space", userId: "owner" };
  const ctx = {
    deps: { artifacts: {}, prisma: {}, maxUploadSizeBytes: 100,
      sandbox: { readFile: sandboxRead }, nativeWorkspaceFile },
    bot: { id: "bot" }, thread: { id: "thread", groupId: null },
    run: { id: "run", spaceId: "space", userId: "owner" },
    computer: { mode: "team", get: computer }, context,
  } as unknown as RunContext;
  const call = {
    name: "attach_file", args: { path: "/native-agent/output.txt" },
    executionId: "call", finish: vi.fn(async value => value),
  } as unknown as ToolCall;
  const block = { kind: "file" as const, name: "output.txt", artifactId: "artifact" };
  vi.mocked(attachWorkspaceFileToThread).mockResolvedValue({ artifactId: "artifact", block } as never);
  expect(await fileTools.attach_file!(ctx, call)).toMatchObject({ ok: true, artifactId: "artifact" });
  expect(nativeWorkspaceFile).toHaveBeenCalledWith("bot", "/native-agent/output.txt", 100, context);
  expect(sandboxRead).not.toHaveBeenCalled();
  expect(computer).not.toHaveBeenCalled();
  expect(attachWorkspaceFileToThread).toHaveBeenCalledWith(expect.anything(),
    expect.objectContaining({ botId: "bot", bytes, operationId: "call" }));
  expect(publishMessage).toHaveBeenCalledWith(ctx.deps, ctx.run, "bot", [block]);
});
