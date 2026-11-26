import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { stdinClosedError } from "@devintern/auth";

import {
  isPromptAbort,
  isPromptInterrupt,
  promptAbortReason,
  promptInterruptedError,
} from "../src/lib/cli/prompt-abort";
import { createPromptSession } from "../src/lib/cli/prompt-session";

/** A fake terminal: keystrokes in, everything readline echoes captured. */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let written = "";
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return { input, output, written: () => written };
}

describe("prompt abort reasons", () => {
  test("Ctrl+C and Ctrl+D both stop setup but are named apart", () => {
    const interrupted = promptInterruptedError();
    expect(isPromptAbort(interrupted)).toBe(true);
    expect(isPromptInterrupt(interrupted)).toBe(true);
    expect(promptAbortReason(interrupted)).toBe("Interrupted (Ctrl+C)");

    const closed = stdinClosedError();
    expect(isPromptAbort(closed)).toBe(true);
    expect(isPromptInterrupt(closed)).toBe(false);
    expect(promptAbortReason(closed)).toBe("Input closed (Ctrl+D)");
  });
});

describe("createPromptSession", () => {
  test("a secret prompt shows the question but never the typed value", async () => {
    const term = fakeTerminal();
    const session = await createPromptSession({ input: term.input, output: term.output });
    try {
      const name = session.prompt("Name: ");
      term.input.write("bob\r");
      expect(await name).toBe("bob");

      const token = session.promptSecret("Token: ");
      term.input.write("s3cret-valXX\x7f\x7fue\r");
      expect(await token).toBe("s3cret-value");

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(term.written()).toContain("bob");
      expect(term.written()).toContain("Token: ");
      expect(term.written()).not.toContain("s3cret");
    } finally {
      session.close();
    }
  });

  test("Ctrl+C at a prompt rejects with an interrupt, not an EOF", async () => {
    const term = fakeTerminal();
    let idle = 0;
    const session = await createPromptSession({
      input: term.input,
      output: term.output,
      onIdleInterrupt: () => idle++,
    });
    const answer = session.prompt("Query: ");
    term.input.write("\x03");
    const error = await answer.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isPromptInterrupt(error)).toBe(true);
    expect(idle).toBe(0);
    // Later prompts fail the same way instead of hanging on a closed reader.
    const later = await session.prompt("Again: ").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isPromptInterrupt(later)).toBe(true);
  });

  test("Ctrl+C while no prompt is open goes to the idle handler", async () => {
    const term = fakeTerminal();
    let idle = 0;
    const session = await createPromptSession({
      input: term.input,
      output: term.output,
      onIdleInterrupt: () => idle++,
    });
    term.input.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(idle).toBe(1);
    session.close();
  });
});
