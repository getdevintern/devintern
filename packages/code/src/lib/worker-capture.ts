/**
 * Worker self-capture: the daemon tees its own console output into
 * `worker.stdout.log` / `worker.stderr.log` under the workspace home.
 *
 * The dashboard Logs tab tails those capture files. By writing them from
 * inside the worker, logs work no matter how the daemon is launched — a
 * generated systemd unit or launchd agent, a hand-written unit, a shell
 * wrapper, or a plain terminal — without every service definition having to
 * redirect stdout/stderr to the right files.
 *
 * Writes are synchronous (`writeSync`) so a crash or `process.exit` mid-line
 * cannot lose buffered output. A failure to open or write the files is never
 * allowed to stop the worker.
 */

import { closeSync, existsSync, openSync, renameSync, statSync, writeSync } from "fs";
import { join, resolve } from "path";
import { format } from "util";

export type WorkerCaptureStream = "out" | "err";

export interface WorkerCaptureHandle {
  /** Absolute paths of the files being appended to. */
  paths: Record<WorkerCaptureStream, string>;
  /** Restore the original console methods and close the file descriptors. */
  stop(): void;
}

export interface WorkerCaptureOptions {
  /** Rotation threshold per file; defaults to {@link WORKER_CAPTURE_ROTATE_BYTES}. */
  maxBytes?: number;
}

/** Capture file names (also tailed by the dashboard; see `worker-logs.ts`). */
const FILE_NAMES: Record<WorkerCaptureStream, string> = {
  out: "worker.stdout.log",
  err: "worker.stderr.log",
};

/** Rename a capture file to `<name>.1` once it grows past this size. */
export const WORKER_CAPTURE_ROTATE_BYTES = 8 * 1024 * 1024;

type ConsoleKeys = "log" | "info" | "debug" | "warn" | "error";

interface Originals {
  log: typeof console.log;
  info: typeof console.info;
  debug: typeof console.debug;
  warn: typeof console.warn;
  error: typeof console.error;
}

/** Rename `path` to `path.1` (replacing any previous rotation) when oversized. */
function rotateIfNeeded(path: string, maxBytes: number): void {
  if (!existsSync(path)) {
    return;
  }
  try {
    if (statSync(path).size > maxBytes) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // Rotation is best-effort; appending to an oversized file beats crashing.
  }
}

/** ISO timestamp prefix, added per line so the dashboard can order entries. */
function timestamp(): string {
  return `${new Date().toISOString()} `;
}

function writeLines(fd: number, chunk: string): void {
  // console methods never end their formatted output in a newline; add one.
  const lines = chunk.split("\n");
  const text = lines.map((line) => `${timestamp()}${line}`).join("\n");
  try {
    writeSync(fd, `${text}\n`);
  } catch {
    // Disk full, file rotated away, …: the console still got the output.
  }
}

/**
 * Start teeing console output into capture files under `dir`.
 *
 * console.log/info/debug go to `worker.stdout.log`, console.warn/error to
 * `worker.stderr.log`; the original methods still run, so foreground
 * terminals keep streaming output. Returns a handle whose `stop()` restores
 * the original console.
 *
 * @param dir - Directory for the capture files (the workspace home)
 * @param options - Rotation threshold override
 */
export function startWorkerCapture(
  dir: string,
  options: WorkerCaptureOptions = {},
): WorkerCaptureHandle {
  const maxBytes = options.maxBytes ?? WORKER_CAPTURE_ROTATE_BYTES;
  const paths: Record<WorkerCaptureStream, string> = {
    out: resolve(join(resolve(dir), FILE_NAMES.out)),
    err: resolve(join(resolve(dir), FILE_NAMES.err)),
  };
  const fds: Record<WorkerCaptureStream, number> = { out: -1, err: -1 };

  for (const stream of ["out", "err"] as const) {
    try {
      rotateIfNeeded(paths[stream], maxBytes);
      fds[stream] = openSync(paths[stream], "a");
    } catch {
      fds[stream] = -1;
    }
  }

  const originals: Originals = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  const tee = (stream: WorkerCaptureStream, original: (...args: unknown[]) => void) => {
    return (...args: unknown[]): void => {
      const fd = fds[stream];
      if (fd !== -1) {
        writeLines(fd, format(...args));
      }
      original(...args);
    };
  };

  console.log = tee("out", originals.log);
  console.info = tee("out", originals.info);
  console.debug = tee("out", originals.debug);
  console.warn = tee("err", originals.warn);
  console.error = tee("err", originals.error);

  return {
    paths,
    stop(): void {
      console.log = originals.log;
      console.info = originals.info;
      console.debug = originals.debug;
      console.warn = originals.warn;
      console.error = originals.error;
      for (const stream of ["out", "err"] as const) {
        if (fds[stream] !== -1) {
          try {
            closeSync(fds[stream]);
          } catch {
            // Already closed.
          }
          fds[stream] = -1;
        }
      }
    },
  };
}
