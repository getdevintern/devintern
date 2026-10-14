/**
 * Harness run logs: one durable transcript per agent harness execution.
 *
 * Every `spawnAgent` call attaches a sink built by {@link createHarnessLogSink}.
 * The sink writes a metadata header, then every stdout/stderr chunk as it
 * streams, then a footer with the exit code, signal, and detected terminal
 * conditions (max turns, usage limit). Because persistence lives at the spawn
 * boundary, a run that fails, times out, is killed, or hits a turn limit still
 * leaves a usable log with whatever output was produced.
 *
 * Files live under `logs/harness/` in the workspace home (`~/.devintern` by
 * default, or `DEVINTERN_WORKSPACE_DIR`). Each execution gets its own file, so
 * no cross-run rotation is needed; retention pruning bounds the directory by
 * age, file count, and total bytes. A single file is additionally truncated at
 * `DEVINTERN_HARNESS_LOG_MAX_FILE_MB` to bound one runaway transcript.
 * Logging is on by default and can be disabled with `DEVINTERN_HARNESS_LOGS=0`.
 *
 * Raw output is written unredacted so the transcript is complete; secrets are
 * masked when the dashboard serves a log (see {@link readHarnessLogContent}).
 * Redaction is best-effort pattern matching, not a guarantee: it covers
 * `KEY=value` / `KEY: value` / `"key": "value"` assignments whose key name
 * smells like a credential, well-known token shapes, and PEM private-key
 * blocks. It does not catch novel secret formats, arbitrary multi-line or
 * standalone base64 secrets, or secrets embedded in prose. Treat harness logs
 * as sensitive and disable persistence with `DEVINTERN_HARNESS_LOGS=0` where
 * transcripts may carry material secrets.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { join, resolve, sep } from "path";

import { detectMaxTurnsReached, detectUsageLimit } from "@devintern/agent-harness";
import type { AgentHarness, AgentOutputSink, AgentRunOutcome } from "@devintern/agent-harness";

import { getActiveRunContext } from "../state/run-recorder";
import type { RunOrigin } from "../state/run-recorder";
import { resolveWorkspaceDir } from "../workspace/paths";
import { redactSecrets, stripAnsi } from "./worker-logs";

/** Subdirectory of the workspace home holding per-execution harness logs. */
export const HARNESS_LOG_DIRNAME = "logs/harness";

/** Extension for harness log files (also used to ignore rotated `*.log.1`). */
const HARNESS_LOG_EXT = ".log";

/** Default retention window; older files are pruned best-effort on write. */
export const HARNESS_LOG_RETENTION_DAYS = 30;

/** Default cap on retained files, oldest pruned first. */
export const HARNESS_LOG_MAX_FILES = 500;

/**
 * Default per-file size cap. Agent transcripts are unbounded, so a single
 * verbose run can otherwise fill the disk; the body is truncated once it
 * reaches this many bytes (the footer is always written).
 */
export const HARNESS_LOG_MAX_FILE_MB = 10;

/** Default total-bytes budget for the log directory, oldest pruned first. */
export const HARNESS_LOG_MAX_TOTAL_MB = 256;

/** Tail window when the dashboard reads a log; older bytes stay on disk. */
export const HARNESS_LOG_READ_BYTES = 512 * 1024;

/** One mebibyte, used to convert the MB retention knobs to bytes. */
const MEBIBYTE = 1024 * 1024;

/** Cap on the command line echoed into the header. */
const MAX_COMMAND_CHARS = 4000;

/** Tail kept in memory solely to run end-of-run detectors. */
const MAX_DETECT_BYTES = 256 * 1024;

/**
 * Everything needed to attribute one harness execution. `origin`/`taskKey`
 * default to the active run (see {@link getActiveRunContext}); call sites may
 * override them for spawns that happen outside a run.
 */
export interface HarnessLogContext {
  /** Harness identity persisted in the header. */
  harness: Pick<AgentHarness, "name" | "displayName" | "supportsMaxTurns">;
  /** Which spawn path this is, e.g. `implementation`, `clarity`, `review`. */
  label?: string;
  /** Run origin override; defaults to the active run's origin, then `task`. */
  origin?: RunOrigin;
  /** Task key override; defaults to the active run's task key. */
  taskKey?: string;
  /** Agent argv (executable + flags), echoed (redacted, truncated) in the header. */
  command?: readonly string[];
  /** Working directory the agent runs in. */
  cwd?: string;
}

/** Metadata parsed from a harness log filename plus its on-disk stat. */
export interface HarnessLogFile {
  name: string;
  size: number;
  modifiedAt: number;
  /** Epoch ms parsed from the filename; null when unparseable. */
  startedAt: number | null;
  origin: string;
  taskKey?: string;
  runId?: number;
  label?: string;
}

/** A harness log's tail content, redacted for safe display. */
export interface HarnessLogContent {
  name: string;
  content: string;
  truncated: boolean;
  totalBytes: number;
}

/** Absolute path of the harness log directory for a workspace. */
export function harnessLogsDir(workspaceDir: string = resolveWorkspaceDir()): string {
  return join(workspaceDir, ...HARNESS_LOG_DIRNAME.split("/"));
}

/** Whether harness logging is enabled (on by default; `DEVINTERN_HARNESS_LOGS=0` opts out). */
export function isHarnessLoggingEnabled(): boolean {
  const raw = process.env.DEVINTERN_HARNESS_LOGS;
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/**
 * Make a filename segment safe and free of the `__` separator.
 *
 * Collapsing runs of `_` is not enough on its own: a segment ending in `_`
 * would abut the `__` separator and form `___`, and `parseHarnessLogName`
 * splits on `__`, shifting every following field. So strip leading/trailing
 * `_` as well (after the length cap, in case the cap itself lands on one).
 */
function sanitizeSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/_{2,}/g, "_")
    .slice(0, 60)
    .replace(/^[_-]+|[_-]+$/g, "");
}

/** ISO timestamp reduced to a filesystem-safe, lexically sortable token. */
function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

/** Parse the compact timestamp token back to epoch ms, or null. */
function parseCompactTimestamp(token: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(token);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, ms] = match;
  const value = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms),
  );
  return Number.isNaN(value) ? null : value;
}

/**
 * Build the log filename:
 * `<startedAt>__<origin>__<run42|norun>__<taskKey|nokey>__<label|run>__<pid>__<rand>.log`.
 * Discoverable, sortable, and cheap to filter without opening the file.
 */
export function harnessLogFileName(meta: {
  startedAt: Date;
  origin: string;
  runId?: number;
  taskKey?: string;
  label?: string;
  pid?: number;
}): string {
  const parts = [
    compactTimestamp(meta.startedAt),
    sanitizeSegment(meta.origin) || "origin",
    meta.runId !== undefined ? `run${meta.runId}` : "norun",
    sanitizeSegment(meta.taskKey ?? "") || "nokey",
    sanitizeSegment(meta.label ?? "") || "run",
    String(meta.pid ?? process.pid),
    Math.random().toString(36).slice(2, 8),
  ];
  return `${parts.join("__")}${HARNESS_LOG_EXT}`;
}

/** Parse a harness log filename into its metadata, or null when it is not one. */
export function parseHarnessLogName(
  name: string,
): Omit<HarnessLogFile, "size" | "modifiedAt"> | null {
  if (!name.endsWith(HARNESS_LOG_EXT)) {
    return null;
  }
  const stem = name.slice(0, -HARNESS_LOG_EXT.length);
  const parts = stem.split("__");
  if (parts.length < 7) {
    return null;
  }
  const [timestamp, origin, runToken, keyToken, label, ,] = parts;
  const runId = runToken?.startsWith("run") ? Number(runToken.slice(3)) : undefined;
  return {
    name,
    startedAt: parseCompactTimestamp(timestamp ?? ""),
    origin: origin ?? "unknown",
    runId: runId !== undefined && Number.isFinite(runId) ? runId : undefined,
    taskKey: keyToken && keyToken !== "nokey" ? keyToken : undefined,
    label: label && label !== "run" ? label : undefined,
  };
}

/** Best-effort write; a failed write must never break the run. */
function safeWrite(fd: number, text: string | Uint8Array): void {
  try {
    const buffer = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
    writeSync(fd, buffer);
  } catch {
    // Disk full / rotated away: terminal streaming already got the output.
  }
}

/** Read a positive integer env override, or the fallback when unset/invalid. */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Prune harness logs older than the retention window, beyond the file cap, or over budget. */
export function pruneHarnessLogs(
  dir: string = harnessLogsDir(),
  options: { retentionDays?: number; maxFiles?: number; maxBytes?: number; now?: number } = {},
): void {
  const retentionDays =
    options.retentionDays ??
    envPositiveInt("DEVINTERN_HARNESS_LOG_RETENTION_DAYS", HARNESS_LOG_RETENTION_DAYS);
  const maxFiles =
    options.maxFiles ?? envPositiveInt("DEVINTERN_HARNESS_LOG_MAX_FILES", HARNESS_LOG_MAX_FILES);
  const maxBytes =
    options.maxBytes ??
    envPositiveInt("DEVINTERN_HARNESS_LOG_MAX_TOTAL_MB", HARNESS_LOG_MAX_TOTAL_MB) * MEBIBYTE;
  const now = options.now ?? Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(HARNESS_LOG_EXT));
  } catch {
    return;
  }
  const entries: { path: string; size: number; modifiedAt: number }[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.mtimeMs < cutoff) {
        unlinkSync(path);
        continue;
      }
      entries.push({ path, size: stat.size, modifiedAt: stat.mtimeMs });
      totalBytes += stat.size;
    } catch {
      // Vanished or unreadable; leave it alone.
    }
  }
  if (entries.length > maxFiles || totalBytes > maxBytes) {
    entries.sort((a, b) => a.modifiedAt - b.modifiedAt);
    let remaining = entries.length;
    for (const entry of entries) {
      if (remaining <= maxFiles && totalBytes <= maxBytes) {
        break;
      }
      try {
        unlinkSync(entry.path);
        totalBytes -= entry.size;
        remaining -= 1;
      } catch {
        // Best-effort.
      }
    }
  }
}

/** Minimum interval between opportunistic prunes on the spawn hot path. */
export const HARNESS_LOG_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const lastPruneMsByDir = new Map<string, number>();

/**
 * Throttled {@link pruneHarnessLogs}. A long-lived worker spawns several agents
 * per task (clarity, implementation, reviews, hook fixes); sweeping the whole
 * directory with a `statSync` per entry on every spawn is wasted work. Prune a
 * given directory at most once per {@link HARNESS_LOG_PRUNE_INTERVAL_MS}.
 */
export function maybePruneHarnessLogs(
  dir: string = harnessLogsDir(),
  now: number = Date.now(),
): void {
  const lastPruneMs = lastPruneMsByDir.get(dir) ?? 0;
  if (now - lastPruneMs < HARNESS_LOG_PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneMsByDir.set(dir, now);
  pruneHarnessLogs(dir);
}

/**
 * Build the per-execution sink for one spawn. Returns undefined when logging
 * is disabled or the log cannot be opened; callers treat a missing sink as a
 * no-op and never fail the run over logging.
 */
export function createHarnessLogSink(ctx: HarnessLogContext): AgentOutputSink | undefined {
  if (!isHarnessLoggingEnabled()) {
    return undefined;
  }
  const dir = harnessLogsDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  maybePruneHarnessLogs(dir);

  const active = getActiveRunContext();
  const origin = ctx.origin ?? active?.origin ?? "task";
  const taskKey = ctx.taskKey ?? active?.taskKey;
  const runId = active?.id;
  const startedAt = new Date();
  const name = harnessLogFileName({
    startedAt,
    origin,
    runId,
    taskKey,
    label: ctx.label,
  });

  let fd: number;
  try {
    fd = openSync(join(dir, name), "a", 0o600);
  } catch {
    return undefined;
  }

  const headerFields: Array<[string, string | number | undefined]> = [
    ["origin", origin],
    ["taskKey", taskKey],
    ["runId", runId],
    ["harness", ctx.harness.name],
    ["displayName", ctx.harness.displayName],
    ["label", ctx.label],
    ["cwd", ctx.cwd],
    ["startedAt", startedAt.toISOString()],
    ["pid", process.pid],
    [
      "command",
      ctx.command && ctx.command.length > 0
        ? redactSecrets(ctx.command.join(" ")).slice(0, MAX_COMMAND_CHARS)
        : undefined,
    ],
  ];
  const header = [
    "=== devintern harness run ===",
    ...headerFields
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`),
    "=== transcript ===",
    "",
  ].join("\n");
  safeWrite(fd, header);

  const maxBodyBytes =
    envPositiveInt("DEVINTERN_HARNESS_LOG_MAX_FILE_MB", HARNESS_LOG_MAX_FILE_MB) * MEBIBYTE;
  let bodyBytes = 0;
  let bodyTruncated = false;

  /** Append transcript bytes, truncating once the per-file cap is reached. */
  const writeBody = (text: string): void => {
    if (bodyTruncated || text.length === 0) {
      return;
    }
    const bytes = Buffer.byteLength(text);
    if (bodyBytes + bytes <= maxBodyBytes) {
      bodyBytes += bytes;
      safeWrite(fd, text);
      return;
    }
    const remaining = maxBodyBytes - bodyBytes;
    if (remaining > 0) {
      safeWrite(fd, Buffer.from(text).subarray(0, remaining));
      bodyBytes = maxBodyBytes;
    }
    bodyTruncated = true;
    safeWrite(
      fd,
      `\n[harness log truncated at ${maxBodyBytes} bytes; remaining output not recorded]\n`,
    );
  };

  let stdoutTail = "";
  let stderrTail = "";
  let closed = false;
  let lastChar = "";
  const startedMs = startedAt.getTime();

  /**
   * Write a transcript chunk as-is. The body is a single interleaved stream:
   * harnesses stream normal progress to stderr and only their final answer to
   * stdout, so tagging each line by origin marks ordinary transcript output as
   * an error. Only the last written byte is tracked, to terminate a trailing
   * partial line at close.
   */
  const writeTranscript = (chunk: string): void => {
    if (chunk.length === 0) {
      return;
    }
    writeBody(chunk);
    lastChar = chunk[chunk.length - 1] ?? lastChar;
  };

  const accumulate = (stream: "stdout" | "stderr", chunk: string): void => {
    const combined = (stream === "stdout" ? stdoutTail : stderrTail) + chunk;
    const tail = combined.length > MAX_DETECT_BYTES ? combined.slice(-MAX_DETECT_BYTES) : combined;
    if (stream === "stdout") {
      stdoutTail = tail;
    } else {
      stderrTail = tail;
    }
  };

  return {
    stdout(chunk: string): void {
      accumulate("stdout", chunk);
      writeTranscript(chunk);
    },
    stderr(chunk: string): void {
      accumulate("stderr", chunk);
      writeTranscript(chunk);
    },
    close(outcome: AgentRunOutcome): void {
      if (closed) {
        return;
      }
      closed = true;
      // Terminate a trailing partial line so the footer starts cleanly.
      if (lastChar !== "" && lastChar !== "\n") {
        writeBody("\n");
      }
      const finishedAt = new Date();
      const maxTurnsReached = detectMaxTurnsReached(
        stdoutTail,
        stderrTail,
        ctx.harness.supportsMaxTurns === true,
      );
      const usage = detectUsageLimit(stdoutTail, stderrTail);
      const footerFields: Array<[string, string | number | boolean | undefined]> = [
        ["finishedAt", finishedAt.toISOString()],
        ["durationMs", finishedAt.getTime() - startedMs],
        ["exitCode", outcome.exitCode],
        ["signal", outcome.signal ?? "none"],
        ["error", outcome.error],
        ["maxTurnsReached", maxTurnsReached],
        ["usageLimited", usage.limited],
        ["truncated", bodyTruncated || undefined],
      ];
      const footer = [
        "",
        "=== end of harness run ===",
        ...footerFields
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}: ${value}`),
        "",
      ].join("\n");
      safeWrite(fd, footer);
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * List harness log files, newest first. A file matches when its run id equals
 * `runId` or its task key equals `taskKey` (so executions that ran before a
 * run id existed still associate with the ticket).
 */
export function listHarnessLogs(
  filter: { runId?: number; taskKey?: string; limit?: number } = {},
  dir: string = harnessLogsDir(),
): HarnessLogFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // Filenames store the sanitized task key; compare against the sanitized
  // filter so a key the namer rewrites (`DEV_` -> `DEV`) is still discoverable.
  const filterKey = filter.taskKey ? sanitizeSegment(filter.taskKey) || undefined : undefined;
  const files: HarnessLogFile[] = [];
  for (const name of names) {
    const parsed = parseHarnessLogName(name);
    if (!parsed) {
      continue;
    }
    const matchesRun = filter.runId !== undefined && parsed.runId === filter.runId;
    const matchesKey = filterKey !== undefined && parsed.taskKey === filterKey;
    if ((filter.runId !== undefined || filterKey !== undefined) && !matchesRun && !matchesKey) {
      continue;
    }
    try {
      const stat = statSync(join(dir, name));
      files.push({ ...parsed, size: stat.size, modifiedAt: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  files.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.modifiedAt - a.modifiedAt);
  return filter.limit !== undefined ? files.slice(0, filter.limit) : files;
}

/** Read the tail of a harness log, stripped of ANSI codes and redacted. */
export function readHarnessLogContent(
  name: string,
  options: { maxBytes?: number; dir?: string } = {},
): HarnessLogContent | null {
  const dir = resolve(options.dir ?? harnessLogsDir());
  if (name !== name.split(/[/\\]/).pop() || !name.endsWith(HARNESS_LOG_EXT)) {
    return null;
  }
  const path = resolve(join(dir, name));
  if (!path.startsWith(dir + sep)) {
    return null;
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  const maxBytes = options.maxBytes ?? HARNESS_LOG_READ_BYTES;
  const start = Math.max(0, size - maxBytes);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const length = size - start;
    const buffer = Buffer.alloc(Math.max(0, length));
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (read <= 0) {
        break;
      }
      filled += read;
    }
    const raw = buffer.subarray(0, filled).toString("utf8");
    // Strip ANSI and redact over the whole tail rather than per line so
    // multi-line secrets (PEM private-key blocks) are matched too.
    const content = redactSecrets(stripAnsi(raw));
    return { name, content, truncated: start > 0, totalBytes: size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a partially-opened file must not mask the read result.
      }
    }
  }
}
