/**
 * One readline session for an interactive wizard, with hidden input for
 * secrets and Ctrl+C told apart from Ctrl+D.
 *
 * Secrets are hidden by routing readline's output through a sink that is
 * muted while a secret prompt is open: readline still edits the line (so
 * backspace, Ctrl+C, and Ctrl+D behave as usual), but nothing it echoes
 * reaches the terminal. This needs no private readline API. Without a
 * terminal there is no echo to hide, so secret prompts read a plain line.
 */

import { Writable } from "node:stream";

import { promptInterruptedError } from "./prompt-abort";

export type PromptFn = (question: string) => Promise<string>;

export interface PromptSession {
  /** Read one line, echoed as typed. */
  prompt: PromptFn;
  /** Read one line without echoing it (falls back to {@link prompt} without a terminal). */
  promptSecret: PromptFn;
  close(): void;
}

export interface PromptSessionIo {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
  /**
   * Ctrl+C while no prompt is open (for example during a connection check).
   * Defaults to re-raising SIGINT so the process stops as it would without
   * readline holding the terminal in raw mode.
   */
  onIdleInterrupt?: () => void;
}

/**
 * The prompts a wizard uses: the injected ones (tests), or a real session
 * over stdin/stdout. `close` is a no-op for injected prompts.
 */
export async function resolveWizardPrompts(injected: {
  prompt?: PromptFn;
  promptSecret?: PromptFn;
}): Promise<PromptSession> {
  if (injected.prompt) {
    return {
      prompt: injected.prompt,
      promptSecret: injected.promptSecret ?? injected.prompt,
      close: () => {},
    };
  }
  const session = await createPromptSession();
  return { ...session, promptSecret: injected.promptSecret ?? session.promptSecret };
}

/** Open a prompt session over stdin/stdout (or the given streams). */
export async function createPromptSession(io: PromptSessionIo = {}): Promise<PromptSession> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const terminal = input.isTTY === true;
  let muted = false;

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  Object.defineProperty(sink, "columns", { get: () => output.columns });
  Object.defineProperty(sink, "isTTY", { get: () => output.isTTY });

  const { createInterface } = await import("node:readline/promises");
  // historySize 0: an arrow-up at a later prompt must never recall a token.
  const rl = createInterface({ input, output: sink, terminal, historySize: 0 });

  let interrupted = false;
  let closed = false;
  // Rejects the open question. Closing readline does not settle a pending
  // `question()` on every runtime (Bun leaves it pending), so Ctrl+C settles
  // it here instead of relying on the close.
  let rejectOpen: ((error: Error) => void) | undefined;
  rl.on("close", () => {
    closed = true;
  });
  rl.on("SIGINT", () => {
    interrupted = true;
    const reject = rejectOpen;
    rl.close();
    if (reject) reject(promptInterruptedError());
    else (io.onIdleInterrupt ?? (() => process.kill(process.pid, "SIGINT")))();
  });

  const prompt: PromptFn = (question) => {
    if (interrupted) return Promise.reject(promptInterruptedError());
    return new Promise<string>((resolve, reject) => {
      rejectOpen = reject;
      rl.question(question)
        .then(resolve)
        .catch((error: unknown) => reject(interrupted ? promptInterruptedError() : error));
    }).finally(() => {
      rejectOpen = undefined;
    });
  };

  const promptSecret: PromptFn = async (question) => {
    if (!terminal) return prompt(question);
    if (interrupted) throw promptInterruptedError();
    output.write(question);
    muted = true;
    try {
      return await prompt("");
    } finally {
      muted = false;
      output.write("\n");
    }
  };

  return {
    prompt,
    promptSecret,
    close: () => {
      if (!closed) rl.close();
    },
  };
}
