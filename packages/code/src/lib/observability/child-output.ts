/**
 * Output handling for worker CLI subprocesses (address-review,
 * resolve-conflicts, CI fixes, auto-merge).
 *
 * The worker's log capture (`worker-capture.ts`) only tees the worker's own
 * console. A child with inherited stdio writes straight to the worker's file
 * descriptors, so under a service manager its output reached only the
 * journal, never `worker.stdout.log`. While a capture is active the child's
 * stdout/stderr are piped instead and forwarded line by line through the
 * console (prefixed with the job label), which writes them to the terminal or
 * journal and to the capture files. Without a capture (a manual command in a
 * terminal) the child keeps inheriting stdio, so its output stays interactive.
 */

import type { ChildProcess } from "child_process";
import type { Readable } from "stream";

import { isWorkerCaptureActive } from "./worker-capture";

/** Stdio mode for a child's stdout/stderr. */
export type ChildOutputMode = "inherit" | "ignore" | "pipe";

/**
 * Pick how a worker subprocess's output is handled: an explicit mode wins
 * (tests pass `"ignore"`), otherwise pipe while the worker log capture is
 * active and inherit when it is not.
 */
export function childOutputMode(explicit?: "inherit" | "ignore"): ChildOutputMode {
  if (explicit) return explicit;
  return isWorkerCaptureActive() ? "pipe" : "inherit";
}

/** Longest partial line held before it is flushed without a newline. */
const MAX_PENDING_CHARS = 64 * 1024;

function forwardStream(
  stream: Readable | null | undefined,
  write: (line: string) => void,
  prefix: string,
): void {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) write(`${prefix}${line}`);
    if (pending.length > MAX_PENDING_CHARS) {
      write(`${prefix}${pending}`);
      pending = "";
    }
  });
  stream.on("end", () => {
    if (pending) write(`${prefix}${pending}`);
    pending = "";
  });
  // A read error must not crash the worker; the child's exit still settles the job.
  stream.on("error", () => {});
}

/**
 * Forward a piped child's stdout and stderr through the console, one line at
 * a time: stdout to `console.log`, stderr to `console.error`. A no-op for
 * streams that are not piped.
 *
 * @param child - The spawned process (spawned with {@link childOutputMode})
 * @param label - Job label shown before every line, e.g. `address-review owner/repo#12`
 */
export function forwardChildOutput(child: ChildProcess, label: string): void {
  const prefix = `[${label}] `;
  forwardStream(child.stdout, (line) => console.log(line), prefix);
  forwardStream(child.stderr, (line) => console.error(line), prefix);
}
