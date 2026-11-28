import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promptRunMode, runInit } from "../src/lib/init/cli";
import { registerManualCheckout } from "../src/lib/workspace/register-checkout";

let tempDir: string;
let logs: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "init-run-mode-test-"));
  logs = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Prompt that answers from a queue and records every question. */
function scriptedPrompt(answers: string[]) {
  const remaining = [...answers];
  const asked: string[] = [];
  const prompt = (question: string): Promise<string> => {
    asked.push(question);
    const next = remaining.shift();
    return next === undefined
      ? Promise.reject(new Error(`unexpected prompt: ${question}`))
      : Promise.resolve(next);
  };
  return { prompt, asked };
}

function baseDeps() {
  return {
    cwd: tempDir,
    interactive: true,
    probe: () => Promise.resolve(),
    getUser: () => Promise.resolve(null),
    listInstalledAgents: () => [{ name: "claude-code", displayName: "Claude Code" }],
    log: (message: string) => logs.push(message),
  };
}

describe("promptRunMode", () => {
  test("Enter and 1 choose the worker, 2 runs by hand, anything else asks again", async () => {
    const log = (message: string) => logs.push(message);
    expect(await promptRunMode(scriptedPrompt([""]).prompt, log)).toBe("worker");
    expect(await promptRunMode(scriptedPrompt(["1"]).prompt, log)).toBe("worker");
    expect(await promptRunMode(scriptedPrompt([" 2 "]).prompt, log)).toBe("manual");
    const retry = scriptedPrompt(["3", "markdown", "2"]);
    expect(await promptRunMode(retry.prompt, log)).toBe("manual");
    expect(retry.asked).toHaveLength(3);
    expect(logs.filter((line) => line === "Please enter 1 or 2.")).toHaveLength(2);
    expect(logs[0]).toContain("How do you want to run tickets?");
    expect(logs[0]).toContain("1) Automatically with a worker (recommended)");
    expect(logs[0]).toContain("2) By hand from this terminal");
  });
});

describe("runInit: run-mode choice", () => {
  test("choosing the worker runs the worker init flow and returns its exit code", async () => {
    const { prompt, asked } = scriptedPrompt(["1"]);
    let workerRuns = 0;

    const code = await runInit({
      ...baseDeps(),
      prompt,
      runWorkerSetup: () => {
        workerRuns++;
        return Promise.resolve(2);
      },
    });

    expect(code).toBe(2);
    expect(workerRuns).toBe(1);
    expect(asked).toEqual(["Enter 1 or 2 [1]: "]);
    // The per-repo wizard never ran.
    expect(logs.join("\n")).not.toContain("Initializing @getdevintern/code");
  });

  test("choosing by hand runs today's per-repo wizard", async () => {
    const { prompt, asked } = scriptedPrompt(["2", "markdown", "", "", "n"]);
    let workerRuns = 0;

    const code = await runInit({
      ...baseDeps(),
      prompt,
      runWorkerSetup: () => {
        workerRuns++;
        return Promise.resolve(0);
      },
    });

    expect(code).toBe(0);
    expect(workerRuns).toBe(0);
    expect(asked[0]).toBe("Enter 1 or 2 [1]: ");
    expect(logs.join("\n")).toContain("Project initialized successfully");
  });

  test("a checkout set up for manual runs skips the question and mentions worker init", async () => {
    const registered = await registerManualCheckout(tempDir, "TASK_TRACKER=markdown\n", () => {});
    expect(registered.ok).toBe(true);
    const { prompt, asked } = scriptedPrompt(["3"]); // keep the current settings

    const code = await runInit({
      ...baseDeps(),
      prompt,
      runWorkerSetup: () => Promise.reject(new Error("worker init must not run")),
    });

    expect(code).toBe(0);
    expect(asked).toEqual(["Enter a number (1-3): "]);
    expect(logs.join("\n")).toContain("`devintern worker init`");
  });

  test("stops after three invalid run-mode answers and returns 1", async () => {
    const { prompt, asked } = scriptedPrompt(["3", "markdown", "maybe"]);
    let workerRuns = 0;

    const code = await runInit({
      ...baseDeps(),
      prompt,
      runWorkerSetup: () => {
        workerRuns++;
        return Promise.resolve(0);
      },
    });

    expect(code).toBe(1);
    expect(workerRuns).toBe(0);
    expect(asked).toHaveLength(3);
    expect(logs.join("\n")).toContain("No valid run mode after 3 attempts");
    expect(logs.join("\n")).toContain("setup stopped. Re-run `devintern init`.");
  });

  test("non-interactive init writes the templates without asking", async () => {
    const code = await runInit({
      ...baseDeps(),
      interactive: false,
      prompt: () => Promise.reject(new Error("no prompts expected")),
      runWorkerSetup: () => Promise.reject(new Error("worker init must not run")),
    });

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Project initialized successfully");
  });
});
