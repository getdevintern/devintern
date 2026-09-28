import { describe, expect, test } from "bun:test";
import { spawnAgent } from "../src/spawn-agent.js";
import type { AgentOutputSink, AgentRunOutcome } from "../src/index.js";

/** A sink that records output and resolves a promise when closed. */
function recordingSink(): {
  sink: AgentOutputSink;
  stdout: () => string;
  stderr: () => string;
  done: Promise<AgentRunOutcome>;
} {
  let stdout = "";
  let stderr = "";
  let resolveDone: (outcome: AgentRunOutcome) => void;
  const done = new Promise<AgentRunOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let closed = false;
  const sink: AgentOutputSink = {
    stdout: (chunk) => (stdout += chunk),
    stderr: (chunk) => (stderr += chunk),
    close: (outcome) => {
      if (!closed) {
        closed = true;
        resolveDone(outcome);
      }
    },
  };
  return { sink, stdout: () => stdout, stderr: () => stderr, done };
}

describe("spawnAgent output sink", () => {
  test("forwards stdout, stderr, and the exit code", async () => {
    const recorder = recordingSink();
    await spawnAgent({
      resolvedPath: "/bin/sh",
      args: ["-c", "echo hello; echo oops >&2; exit 3"],
      spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
      sink: recorder.sink,
    });

    const outcome = await recorder.done;
    expect(recorder.stdout()).toContain("hello");
    expect(recorder.stderr()).toContain("oops");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.signal).toBeNull();
  });

  test("reassembles a multi-byte character split across data chunks", async () => {
    const recorder = recordingSink();
    // The euro sign (E2 82 AC) is written as two separate chunks split after
    // its first two bytes, so a naive per-chunk decode would emit U+FFFD.
    await spawnAgent({
      resolvedPath: "/bin/sh",
      args: ["-c", "printf '\\342\\202'; sleep 0.3; printf '\\254'; printf '\\n'"],
      spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
      sink: recorder.sink,
    });
    await recorder.done;
    expect(recorder.stdout()).toBe("€\n");
    expect(recorder.stdout()).not.toContain("\uFFFD");
  });

  test("reports spawn failures instead of leaving the sink open", async () => {
    const recorder = recordingSink();
    await spawnAgent({
      resolvedPath: "/nonexistent/devintern-agent-xyz",
      args: [],
      spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
      sink: recorder.sink,
    });
    const outcome = await recorder.done;
    expect(outcome.exitCode).toBe(-1);
    expect(outcome.error ?? "").not.toBe("");
  });

  test("closes the sink when sandbox wrapping throws", async () => {
    const recorder = recordingSink();
    const sandbox = {
      provider: {
        name: "boom",
        displayName: "boom",
        priority: 1,
        detect: async () => ({ available: true }),
        wrapCommand: () => {
          throw new Error("sandbox exploded");
        },
      },
      detection: { available: true },
    };
    await expect(
      spawnAgent({
        resolvedPath: "/usr/bin/agent",
        args: [],
        spawnOptions: { stdio: ["ignore", "ignore", "ignore"] },
        sandbox: sandbox as never,
        sink: recorder.sink,
      }),
    ).rejects.toThrow("sandbox exploded");
    const outcome = await recorder.done;
    expect(outcome.error).toBe("sandbox exploded");
  });
});
