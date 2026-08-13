/**
 * Runtime-agnostic stdin helpers using Node.js built-ins.
 *
 * Replaces bash-spawning confirmation prompts with cross-platform `node:readline`.
 */

import { createInterface } from "node:readline";

interface StdinState {
  /** Lines readline emitted past the one being awaited (piped multi-line input). */
  pending: string[];
  ended: boolean;
}

/** Buffered lines / EOF state, keyed per stream so a swapped stdin starts fresh. */
const stdinStates = new WeakMap<NodeJS.ReadableStream, StdinState>();

function getStdinState(stdin: NodeJS.ReadableStream): StdinState {
  let state = stdinStates.get(stdin);
  if (!state) {
    state = { pending: [], ended: false };
    stdinStates.set(stdin, state);
  }
  return state;
}

/**
 * Read one line from stdin.
 *
 * @returns The next input line, or `null` when stdin ends (Ctrl-D, closed pipe)
 * before a line arrives.
 */
function readStdinLine(): Promise<string | null> {
  const stdin = process.stdin;
  const state = getStdinState(stdin);

  const buffered = state.pending.shift();
  if (buffered !== undefined) {
    return Promise.resolve(buffered);
  }
  if (state.ended) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin });
    let settled = false;
    rl.on("line", (line) => {
      // readline keeps emitting lines from an already-buffered chunk even
      // after close(), so stash extras for the next call instead of dropping them.
      if (settled) {
        state.pending.push(line);
        return;
      }
      settled = true;
      // Resolve before close(): close() emits "close" synchronously.
      resolve(line);
      rl.close();
    });
    rl.once("close", () => {
      if (!settled) {
        settled = true;
        state.ended = true;
        resolve(null);
      }
    });
  });
}

/**
 * Ask the user for yes/no confirmation on stdin.
 *
 * Safe to call sequentially (e.g. in a loop): answers buffered in a single
 * piped chunk are preserved across calls.
 *
 * @param message - Prompt text displayed before `(Y/n)`.
 * @returns `true` for yes (including empty input), `false` for no or when
 * stdin closes before an answer arrives.
 */
/**
 * Ask the user for a free-text answer on stdin.
 *
 * @param message - Prompt text displayed before the input cursor.
 * @returns Trimmed answer; empty string on read error/close.
 */
export async function askText(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value: string): void => {
      if (!resolved) {
        resolved = true;
        rl.close();
        resolve(value.trim());
      }
    };
    rl.on("close", () => safeResolve(""));
    rl.question(message, safeResolve);
  });
}

export async function askConfirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} (Y/n): `);

  while (true) {
    const line = await readStdinLine();
    if (line === null) {
      return false;
    }

    const trimmed = line.trim().toLowerCase();
    if (trimmed === "" || trimmed === "y" || trimmed === "yes") {
      return true;
    }
    if (trimmed === "n" || trimmed === "no") {
      return false;
    }
    process.stdout.write(`Please answer 'y' or 'n' (default: y): `);
  }
}
