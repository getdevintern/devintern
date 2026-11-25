import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runInit } from "../src/lib/init/cli";
import { isPromptAbort } from "../src/lib/cli/prompt-abort";
import { registerManualCheckout } from "../src/lib/workspace/register-checkout";

const ABORT_MESSAGE = "❌ Input closed (Ctrl+D); setup stopped. Re-run `devintern init`.";

let tempDir: string;
let logs: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "init-command-test-"));
  logs = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** The rejection Bun's readline raises when stdin hits EOF. */
function ctrlDError(): Error {
  const error = new Error("Aborted with Ctrl+D") as NodeJS.ErrnoException;
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/** Prompt that answers from a queue, then rejects with `failure`. */
function promptThenFail(answers: string[], failure: Error) {
  const remaining = [...answers];
  const asked: string[] = [];
  const prompt = (question: string): Promise<string> => {
    asked.push(question);
    const next = remaining.shift();
    return next === undefined ? Promise.reject(failure) : Promise.resolve(next);
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

describe("isPromptAbort", () => {
  test("matches the readline Ctrl+D rejection only", () => {
    expect(isPromptAbort(ctrlDError())).toBe(true);
    expect(isPromptAbort(new Error("boom"))).toBe(false);
    expect(isPromptAbort("AbortError")).toBe(false);
  });
});

describe("runInit: closed input", () => {
  test("first-run wizard: Ctrl+D at the tracker prompt exits 1 with one line", async () => {
    const { prompt, asked } = promptThenFail([], ctrlDError());

    const code = await runInit({ ...baseDeps(), prompt });

    expect(code).toBe(1);
    expect(asked).toHaveLength(1);
    expect(logs.at(-1)).toBe(`\n${ABORT_MESSAGE}`);
    expect(logs.filter((line) => line.includes("Input closed"))).toHaveLength(1);
  });

  test("first-run wizard: Ctrl+D inside the sign-in flow stops setup", async () => {
    const { prompt } = promptThenFail(
      ["markdown", "", "", "y"], // tracker, tasks dir, PR token, accept sign-in
      new Error("no more prompts expected"),
    );

    const code = await runInit({
      ...baseDeps(),
      prompt,
      signIn: () => Promise.reject(ctrlDError()),
    });

    expect(code).toBe(1);
    expect(logs.at(-1)).toBe(`\n${ABORT_MESSAGE}`);
    expect(logs.join("\n")).not.toContain("Sign-in failed");
    expect(logs.join("\n")).not.toContain("Project initialized successfully");
  });

  test("registered-checkout upgrade: Ctrl+D at the menu exits 1 with one line", async () => {
    const registered = await registerManualCheckout(tempDir, "TASK_TRACKER=markdown\n", () => {});
    expect(registered.ok).toBe(true);
    const { prompt, asked } = promptThenFail([], ctrlDError());

    const code = await runInit({ ...baseDeps(), prompt });

    expect(code).toBe(1);
    expect(asked).toEqual(["Enter a number (1-3): "]);
    expect(logs.at(-1)).toBe(`\n${ABORT_MESSAGE}`);
  });

  test("other prompt errors propagate unchanged in the wizard", async () => {
    const failure = new Error("disk on fire");
    const { prompt } = promptThenFail([], failure);

    await expect(runInit({ ...baseDeps(), prompt })).rejects.toBe(failure);
    expect(logs.join("\n")).not.toContain("Input closed");
  });

  test("other prompt errors propagate unchanged in the upgrade", async () => {
    await registerManualCheckout(tempDir, "TASK_TRACKER=markdown\n", () => {});
    const failure = new Error("disk on fire");
    const { prompt } = promptThenFail([], failure);

    await expect(runInit({ ...baseDeps(), prompt })).rejects.toBe(failure);
    expect(logs.join("\n")).not.toContain("Input closed");
  });
});
