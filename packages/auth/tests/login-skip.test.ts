import { describe, expect, test } from "bun:test";

import { createAuthCallbackServer } from "../src/auth-callback";
import { LoginSkippedError, isLoginSkipped } from "../src/index";

describe("sign-in skip", () => {
  test("cancel rejects a pending callback wait with the given reason", async () => {
    const server = await createAuthCallbackServer();
    try {
      const waiting = server.waitForCode(5_000);
      server.cancel(new LoginSkippedError());
      const error = await waiting.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(isLoginSkipped(error)).toBe(true);
    } finally {
      await server.stop(0);
    }
  });

  test("isLoginSkipped is false for other errors", () => {
    expect(isLoginSkipped(new Error("Timed out waiting for sign-in callback."))).toBe(false);
    expect(isLoginSkipped("skip")).toBe(false);
  });

  /** Run the wait in a child whose stdin is `stdin`; returns its RESULT line. */
  async function runWait(stdin: string, skipCommand: string | undefined): Promise<unknown> {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `import { createAuthCallbackServer } from "./src/auth-callback";
import { isLoginSkipped, watchLoginInput } from "./src/index";
const server = await createAuthCallbackServer();
const status = [];
const stop = watchLoginInput(server, (m) => status.push(m), true, ${JSON.stringify(skipCommand)});
let outcome;
try {
  outcome = { code: await server.waitForCode(1500) };
} catch (error) {
  outcome = { skipped: isLoginSkipped(error), message: error.message };
}
stop();
await server.stop(0);
console.log("RESULT:" + JSON.stringify({ outcome, status }));`,
      ],
      { cwd: new URL("..", import.meta.url).pathname, stdin: "pipe", stdout: "pipe" },
    );
    proc.stdin.write(stdin);
    proc.stdin.flush();
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const result = output.split("RESULT:")[1];
    if (!result) throw new Error(`No result in output:\n${output}`);
    return JSON.parse(result.trim());
  }

  test("Enter skips the wait and the hint names the later command", async () => {
    const result = (await runWait("\n", "devintern worker login github")) as {
      outcome: { skipped?: boolean };
      status: string[];
    };
    expect(result.outcome.skipped).toBe(true);
    expect(result.status).toContain(
      "Press Enter to skip and sign in later with `devintern worker login github`.",
    );
  });

  test("a pasted callback address still completes the wait", async () => {
    const result = (await runWait(
      "http://127.0.0.1:1/auth/callback?code=abc\n",
      "devintern worker login github",
    )) as { outcome: { code?: string } };
    expect(result.outcome.code).toBe("abc");
  });

  test("without a skip command an empty line is ignored", async () => {
    const result = (await runWait("\n", undefined)) as {
      outcome: { skipped?: boolean; message?: string };
    };
    expect(result.outcome.skipped).toBe(false);
    expect(result.outcome.message).toContain("Timed out");
  });

  test("a finished sign-in prompt leaves stdin flowing for the wizard that was reading it", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `import { createInterface } from "node:readline";
import { promptForLoginMethod, watchStdinLines } from "./src/login-provider";
const wizard = [];
// Stands in for the setup wizard's own prompt session on stdin.
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => wizard.push(line));
await new Promise((resolve) => setTimeout(resolve, 100));
const { method } = await promptForLoginMethod();
const stop = watchStdinLines(() => {});
await new Promise((resolve) => setTimeout(resolve, 100));
stop();
await new Promise((resolve) => setTimeout(resolve, 400));
rl.close();
console.log("RESULT:" + JSON.stringify({ method, wizard }));`,
      ],
      { cwd: new URL("..", import.meta.url).pathname, stdin: "pipe", stdout: "pipe" },
    );
    proc.stdin.write("first\n");
    proc.stdin.flush();
    await Bun.sleep(150);
    proc.stdin.write("1\n");
    proc.stdin.flush();
    await Bun.sleep(300);
    proc.stdin.write("after\n");
    proc.stdin.end();
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(output.split("RESULT:")[1]?.trim() ?? "null") as {
      method: string;
      wizard: string[];
    };
    expect(result.method).toBe("github");
    expect(result.wizard).toContain("after");
  });
});
