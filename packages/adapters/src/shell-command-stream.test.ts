import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import {
  deliverFinishedShells,
  formatFinishedShellCommand,
  isRunningShellCommand,
  observeShellCommand,
  pendingShellCommand,
} from "./shell-command-stream.js";

describe("observeShellCommand", () => {
  it("redacts provider errors before they reach the runtime", async () => {
    const secret = "fake-shell-error-secret";
    const error = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "starting" };
        throw new Error(`Provider failed with ${secret}`, { cause: new Error(secret) });
      })(),
      { secrets: [secret] },
    ).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Provider failed with [redacted]");
    expect((error as Error).stack).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();
  });

  it("returns a fast command only after it exits", async () => {
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "hello\n" };
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: [],
        idleMs: 30,
        onOutput: (snapshot) => {
          seen.push(snapshot.stdout);
        },
      },
    );

    expect(seen).toEqual(["hello\n"]);
    expect(observed.completion).toBeUndefined();
    expect(observed.result).toEqual({ stdout: "hello\n", stderr: "", code: 0 });
  });

  it("returns output and redacts secrets before the command exits", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    let sawOutputBeforeExit = false;
    const observedPromise = observeShellCommand(
      (async function* () {
        yield {
          type: "stdout" as const,
          data: "code: ABCD-1234\nhttps://github.com/login/device\n",
        };
        yield { type: "stderr" as const, data: "token super-secret-token\n" };
        await exitGate;
        sawOutputBeforeExit = true;
        yield { type: "stdout" as const, data: "logged in\n" };
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["super-secret-token"],
        idleMs: 20,
      },
    );

    const observed = await observedPromise;
    expect(sawOutputBeforeExit).toBe(false);
    expect(observed.result).toMatchObject({ code: null, running: true });
    expect(observed.result.stdout).toContain("ABCD-1234");
    expect(observed.result.stdout).toContain("https://github.com/login/device");
    expect(observed.result.stderr).not.toContain("super-secret-token");
    expect(observed.result.stderr).toContain("[redacted]");
    expect(observed.completion).toBeDefined();

    releaseExit();
    const final = await observed.completion;
    expect(final).toMatchObject({ code: 0 });
    expect(final?.stdout).toContain("logged in");
    expect(final?.stdout).toContain("ABCD-1234");
    expect(`${final?.stdout}${final?.stderr}`).not.toContain("super-secret-token");
  });

  it("redacts a secret split across chunks before returning it", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "prefix super-" };
        yield { type: "stdout" as const, data: "secret-token suffix\n" };
        await exitGate;
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["super-secret-token"],
        idleMs: 20,
        onOutput: (snapshot) => {
          seen.push(snapshot.stdout);
        },
      },
    );

    expect(seen[0]).not.toContain("super-");
    expect(seen.at(-1)).toBe("prefix [redacted] suffix\n");
    expect(observed.result.stdout).toBe("prefix [redacted] suffix\n");
    expect(observed.result.stdout).not.toContain("super-secret-token");
    releaseExit();
    await observed.completion;
  });

  it("withholds a stdout secret prefix when stderr has unrelated text", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const seen: Array<{ stdout: string; stderr: string }> = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "prefix super-" };
        yield { type: "stderr" as const, data: "unrelated noise" };
        await exitGate;
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["super-secret-token"],
        idleMs: 20,
        onOutput: (snapshot) => {
          seen.push({ stdout: snapshot.stdout, stderr: snapshot.stderr });
        },
      },
    );

    expect(isRunningShellCommand(observed.result)).toBe(true);
    expect(observed.result.stdout).toBe("prefix ");
    expect(observed.result.stderr).toBe("unrelated noise");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((snapshot) => !snapshot.stdout.includes("super-"))).toBe(true);
    expect(seen.some((snapshot) => snapshot.stderr === "unrelated noise")).toBe(true);
    releaseExit();
    await observed.completion;
  });

  it("withholds a secret prefix from the still-running result", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "prefix super-" };
        await exitGate;
        yield { type: "stdout" as const, data: "secret-token suffix\n" };
        yield { type: "exit" as const, code: 0 };
      })(),
      { secrets: ["super-secret-token"], idleMs: 20 },
    );

    expect(isRunningShellCommand(observed.result)).toBe(true);
    expect(observed.result.stdout).toBe("prefix ");
    expect(observed.result.stdout).not.toContain("super-");
    releaseExit();
    const final = await observed.completion;
    expect(final?.stdout).toBe("prefix [redacted] suffix\n");
    expect(final?.stdout).not.toContain("super-secret-token");
  });

  it("withholds an incomplete secret split across stdout and stderr while running", async () => {
    let releaseExit: () => void = () => undefined;
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "ABCDE" };
        yield { type: "stderr" as const, data: "FGH" };
        await exitGate;
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["ABCDEFGHIJ"],
        idleMs: 20,
        onOutput: (snapshot) => {
          seen.push(`${snapshot.stdout}${snapshot.stderr}`);
        },
      },
    );

    expect(isRunningShellCommand(observed.result)).toBe(true);
    expect(`${observed.result.stdout}${observed.result.stderr}`).toBe("");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((line) => !line.includes("ABCDE") && !line.includes("FGH"))).toBe(true);
    releaseExit();
    const final = await observed.completion;
    expect(`${final?.stdout}${final?.stderr}`).toBe("ABCDEFGH");
  });

  it("redacts a secret split across stdout and stderr before it is joined", async () => {
    const seen: string[] = [];
    const observed = await observeShellCommand(
      (async function* () {
        yield { type: "stdout" as const, data: "pre SECR" };
        yield { type: "stderr" as const, data: "ET123 post" };
        yield { type: "exit" as const, code: 0 };
      })(),
      {
        secrets: ["SECRET123"],
        idleMs: 30,
        onOutput: (snapshot) => {
          seen.push(`${snapshot.stdout}${snapshot.stderr}`);
        },
      },
    );

    const joined = `${observed.result.stdout}${observed.result.stderr}`;
    expect(joined).toBe("pre [redacted] post");
    expect(joined).not.toContain("SECRET123");
    expect(seen.every((line) => !line.includes("SECRET123"))).toBe(true);
  });
});

describe("deliverFinishedShells", () => {
  function turn(stdout = "", stderr = "") {
    const receipt = {
      role: "toolResult" as const,
      toolCallId: "shell-1",
      toolName: "shell",
      content: [{ type: "text" as const, text: "running" }],
      details: { stdout, stderr, code: null, running: true },
      isError: false,
      timestamp: 1,
    };
    return { receipt, context: { messages: [receipt] as AgentMessage[] }, toolResults: [] };
  }

  it("updates the original receipt and continues for new output without adding user messages", async () => {
    let release: (result: { stdout: string; stderr: string; code: number }) => void = () =>
      undefined;
    const completion = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      release = resolve;
    });
    const pending = [pendingShellCommand("shell-1", completion)];
    const current = turn();
    const delivering = deliverFinishedShells(pending, current);

    await Promise.resolve();
    expect(current.receipt.details.code).toBeNull();

    release({ stdout: "logged in\n", stderr: "", code: 0 });
    expect(await delivering).toBe(true);
    expect(current.receipt.details).toEqual({ stdout: "logged in\n", stderr: "", code: 0 });
    expect(current.context.messages).toHaveLength(1);
    expect(pending).toEqual([]);
  });

  it("silently records a successful exit when all output was already seen", async () => {
    const current = turn("ok\n");
    const pending = [
      pendingShellCommand("shell-1", Promise.resolve({ stdout: "ok\n", stderr: "", code: 0 })),
    ];
    expect(await deliverFinishedShells(pending, current)).toBe(false);
    expect(current.receipt.details.code).toBe(0);
    expect(pending).toEqual([]);
  });

  it("continues for failure even when its output was already seen", async () => {
    const current = turn("", "failed");
    expect(
      await deliverFinishedShells(
        [
          pendingShellCommand(
            "shell-1",
            Promise.resolve({ stdout: "", stderr: "failed", code: 1 }),
          ),
        ],
        current,
      ),
    ).toBe(true);
    expect(current.receipt.isError).toBe(true);
  });

  it("records rejected completions as failures", async () => {
    const current = turn();
    expect(
      await deliverFinishedShells(
        [pendingShellCommand("shell-1", Promise.reject(new Error("disconnected")))],
        current,
      ),
    ).toBe(true);
    expect(current.receipt.details).toEqual({ stdout: "", stderr: "disconnected", code: 1 });
  });

  it("does not wait on the turn that first received the live output", async () => {
    let release: (result: { stdout: string; stderr: string; code: number }) => void = () =>
      undefined;
    const completion = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      release = resolve;
    });
    const pending = [pendingShellCommand("shell-1", completion)];
    const current = turn("code: ABCD-1234\n");
    expect(
      await deliverFinishedShells(pending, { ...current, toolResults: [current.receipt] }),
    ).toBe(false);

    expect(pending).toHaveLength(1);
    release({ stdout: "ok\n", stderr: "", code: 0 });
    expect(await deliverFinishedShells(pending, current)).toBe(true);
    expect(current.receipt.details.code).toBe(0);
  });

  it("drains older ready receipts while another command is still running", async () => {
    const current = turn("ok");
    const pending = [
      pendingShellCommand("shell-1", Promise.resolve({ stdout: "ok", stderr: "", code: 0 })),
      pendingShellCommand("shell-2", new Promise(() => undefined)),
    ];
    await Promise.resolve();
    expect(
      await deliverFinishedShells(pending, {
        ...current,
        toolResults: [{ toolName: "shell", details: { code: null, running: true } }],
      }),
    ).toBe(false);
    expect(pending.map((item) => item.toolCallId)).toEqual(["shell-2"]);
    expect(current.receipt.details.code).toBe(0);
  });

  it("does not consume a receipt or continue after cancellation", async () => {
    const current = turn();
    const pending = [
      pendingShellCommand("shell-1", Promise.resolve({ stdout: "news", stderr: "", code: 0 })),
    ];
    expect(await deliverFinishedShells(pending, current, AbortSignal.abort())).toBe(false);
    expect(pending).toHaveLength(1);
    expect(current.receipt.details.code).toBeNull();
  });

  it("keeps unmatched receipts instead of injecting unowned completion messages", async () => {
    const pending = [
      pendingShellCommand("missing", Promise.resolve({ stdout: "news", stderr: "", code: 0 })),
    ];
    const current = turn();
    expect(await deliverFinishedShells(pending, current)).toBe(false);
    expect(pending).toHaveLength(1);
    expect(current.context.messages).toHaveLength(1);
  });
});

const LONG_OUTPUT = `START\n${"compiling step\n".repeat(3_000)}ERROR: build failed\n`;
// The omission marker, the newlines around it and one surrogate kept whole.
const MARKER_OVERHEAD = 200;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function finishedBody(stream: "stdout" | "stderr", output: string): string {
  const text = formatFinishedShellCommand({
    stdout: stream === "stdout" ? output : "",
    stderr: stream === "stderr" ? output : "",
    code: 1,
  });
  return JSON.parse(text)[stream];
}

describe("formatFinishedShellCommand", () => {
  it.each(["stdout", "stderr"] as const)(
    "keeps the head and tail of long %s verbatim",
    (stream) => {
      const body = finishedBody(stream, LONG_OUTPUT);
      expect(body.startsWith(LONG_OUTPUT.slice(0, 6_000))).toBe(true);
      expect(body.endsWith(LONG_OUTPUT.slice(-6_000))).toBe(true);
      expect(body).toContain("[Tool result truncated");
      expect(body.length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT + MARKER_OVERHEAD);
    },
  );

  it("leaves output at the limit unchanged and shortens anything longer", () => {
    const atLimit = "x".repeat(TOOL_RESULT_TEXT_LIMIT);
    expect(finishedBody("stdout", atLimit)).toBe(atLimit);
    const overLimit = finishedBody("stdout", `${atLimit}y`);
    expect(overLimit).toContain("[Tool result truncated");
    expect(overLimit.endsWith("y")).toBe(true);
  });

  it("shortens JSON output as plain text", () => {
    const json = JSON.stringify(
      { packages: Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`pkg-${i}`, i])) },
      null,
      2,
    );
    const body = finishedBody("stdout", json);
    expect(body.startsWith(json.slice(0, 6_000))).toBe(true);
    expect(body.endsWith(json.slice(-6_000))).toBe(true);
    expect(body).not.toContain("contextTruncated");
    expect(body.length).toBeLessThanOrEqual(TOOL_RESULT_TEXT_LIMIT + MARKER_OVERHEAD);
  });

  it("does not split a surrogate pair at either cut", () => {
    const body = finishedBody("stdout", `a${"😀".repeat(10_000)}b`);
    expect(body).not.toMatch(LONE_SURROGATE);
    expect(body.startsWith("a😀")).toBe(true);
    expect(body.endsWith("😀b")).toBe(true);
  });
});
