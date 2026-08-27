/**
 * Worker log tailing for the dashboard.
 *
 * The worker daemon logs to stdout/stderr. When it runs as a background
 * service those streams are captured into `worker.stdout.log` /
 * `worker.stderr.log` in the working directory (launchd config written by
 * `worker-init.ts`) or into the system journal (systemd). This module tails
 * the capture files so the dashboard can surface recent worker log entries
 * without SSH access — the same local-data philosophy as the SQLite-backed
 * endpoints in `dashboard-api.ts`.
 *
 * Reads are strictly bounded: at most `maxBytesPerFile` bytes from the end of
 * each file are touched, and at most `limit` entries are returned. Lines are
 * stripped of ANSI codes, classified by severity, and obvious credentials are
 * masked before anything leaves this machine.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "fs";
import { join, resolve } from "path";

export type WorkerLogLevel = "info" | "warn" | "error";

export type LogStream = "out" | "err";

export interface LogEntry {
  /** 0-based position within the returned window (oldest first). */
  index: number;
  /** Epoch ms parsed from a leading timestamp; null when the line has none. */
  timestamp: number | null;
  level: WorkerLogLevel;
  stream: LogStream;
  message: string;
  /** Best-effort task key extracted from the message (`PROJ-123`). */
  taskKey: string | null;
}

export interface LogSourceInfo {
  path: string;
  stream: LogStream;
  exists: boolean;
  /** Total file size when readable; -1 otherwise. */
  totalBytes: number;
  /** Bytes actually parsed (the tail window). */
  readBytes: number;
  /** True when older content existed before the read window. */
  truncated: boolean;
  /** Read failure (permissions, transient rewrite); empty otherwise. */
  error: string;
}

export interface ReadWorkerLogsOptions {
  /** Directories holding candidate capture files (primary first). */
  dirs?: string[];
  /** Maximum entries returned (the most recent ones). Default 500. */
  limit?: number;
  /** Only return entries of this level. Default "all". */
  level?: WorkerLogLevel | "all";
  /** Tail window per file. Default 256 KiB. */
  maxBytesPerFile?: number;
}

export interface WorkerLogsResult {
  /** Whether any capture file was found (false on a fresh install). */
  available: boolean;
  entries: LogEntry[];
  sources: LogSourceInfo[];
  /** True when entries exist beyond the byte window or the entry limit. */
  truncated: boolean;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES_PER_FILE = 256 * 1024;
const MAX_MESSAGE_CHARS = 4000;

/** Capture file names from the launchd service definition (see worker-init.ts). */
const LOG_FILES: { name: string; stream: LogStream }[] = [
  { name: "worker.stdout.log", stream: "out" },
  { name: "worker.stderr.log", stream: "err" },
];

/** CSI escape sequences (colors, cursor moves) emitted by colorizers. */
// oxlint-disable-next-line no-control-regex -- these are control characters by definition
const ANSI_PATTERN = /\x1B\[[0-9;?]*[A-Za-z]/g;

/** Strip ANSI escapes and carriage returns so lines render cleanly. */
export function stripAnsi(line: string): string {
  return line.replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

/**
 * Parse an optional leading ISO-like timestamp prefix (`2026-08-27T12:34:56Z`,
 * `2026-08-27 12:34:56.123`, journalctl short-iso with offset, …) and return
 * epoch ms plus the rest of the line. A date/time without zone counts as
 * local time. Returns null for bare dates and everything else so we never
 * guess timestamps we cannot support.
 */
export function parseTimestampPrefix(line: string): { timestampMs: number; rest: string } | null {
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,6}))?(?:\s*(Z|z|[+-]\d{2}:?\d{2}))?\s*/,
  );
  if (!match) {
    return null;
  }
  const [, date, time, fraction, zone] = match;
  const normalized = `${date}T${time}${fraction ? `.${fraction}` : ""}${zone ?? ""}`;
  const timestampMs = Date.parse(normalized);
  if (Number.isNaN(timestampMs)) {
    return null;
  }
  return { timestampMs, rest: line.slice(match[0].length) };
}

/**
 * Classify a line's severity. Explicit markers win over the stream heuristic,
 * because the daemon writes warnings through console.error too.
 */
export function classifyLevel(stream: LogStream, rawLine: string): WorkerLogLevel {
  const line = stripAnsi(rawLine);
  if (line.includes("❌") || /\b(?:FATAL|ERROR)\b/i.test(line)) {
    return "error";
  }
  if (line.includes("⚠") || /\bWARN(?:ING)?\b/i.test(line)) {
    return "warn";
  }
  return stream === "err" ? "error" : "info";
}

/** Uppercase prefixes that look like ticket keys but never are. */
const TASK_KEY_STOP_LIST = new Set([
  "SHA",
  "HTTP",
  "HTTPS",
  "UTF",
  "DNS",
  "AWS",
  "UUID",
  "SSL",
  "TLS",
  "CVE",
  "ISO",
]);

/** First Jira-style task key in a message (`PROJ-123`), or null. */
export function extractTaskKey(message: string): string | null {
  for (const match of message.matchAll(/\b([A-Z][A-Z0-9]{1,19}-\d{1,10})\b/g)) {
    const key = match[1];
    if (!key) {
      continue;
    }
    const prefix = key.split("-")[0];
    if (prefix && TASK_KEY_STOP_LIST.has(prefix)) {
      continue;
    }
    return key;
  }
  return null;
}

/**
 * Mask obvious credentials before serving a line: KEY=value assignments whose
 * key smells like a secret, plus common token shapes that can appear echoed
 * without a variable name.
 */
export function redactSecrets(message: string): string {
  let redacted = message.replace(
    /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api_?key|private[_-]?key|access[_-]?key|pat)[a-z0-9_]*)\s*=\s*(\S+)/gi,
    (_match, key: string) => `${key}=[redacted]`,
  );
  redacted = redacted
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
  return redacted;
}

interface RawEntry {
  timestamp: number | null;
  level: WorkerLogLevel;
  stream: LogStream;
  message: string;
  seq: number;
}

function parseSlice(content: string, stream: LogStream): RawEntry[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const entries: RawEntry[] = [];
  for (const [seq, rawLine] of lines.entries()) {
    const line = stripAnsi(rawLine);
    if (!line.trim()) {
      continue;
    }
    const prefix = parseTimestampPrefix(line);
    const body = redactSecrets(prefix ? prefix.rest : line);
    entries.push({
      timestamp: prefix?.timestampMs ?? null,
      level: classifyLevel(stream, line),
      stream,
      message: body.length > MAX_MESSAGE_CHARS ? `${body.slice(0, MAX_MESSAGE_CHARS)}…` : body,
      seq,
    });
  }
  return entries;
}

/**
 * Positional read of `[start, fileSize)` without ever holding more than the
 * window itself (plus one scan buffer) in memory.
 */
function readWindow(fd: number, start: number, size: number): Buffer {
  const windowBytes = Buffer.alloc(Math.max(0, size - start));
  let filled = 0;
  while (filled < windowBytes.length) {
    const read = readSync(fd, windowBytes, filled, windowBytes.length - filled, start + filled);
    if (read <= 0) {
      break;
    }
    filled += read;
  }
  return windowBytes.subarray(0, filled);
}

/**
 * Advance `rawStart` just past the first newline at or after it, so the
 * window opens on a complete line. Falls back to `rawStart` when the rest of
 * the file has no newline (one giant trailing line).
 */
function snapToLineStart(fd: number, rawStart: number, size: number): number {
  const probeBuffer = Buffer.alloc(8192);
  let cursor = rawStart;
  while (cursor < size) {
    const probeLength = Math.min(probeBuffer.length, size - cursor);
    const read = readSync(fd, probeBuffer, 0, probeLength, cursor);
    if (read <= 0) {
      break;
    }
    const newlineOffset = probeBuffer.subarray(0, read).indexOf(0x0a);
    if (newlineOffset !== -1) {
      return cursor + newlineOffset + 1;
    }
    cursor += read;
  }
  return rawStart;
}

function readSource(
  filePath: string,
  stream: LogStream,
  maxBytes: number,
): {
  source: LogSourceInfo;
  entries: RawEntry[];
} {
  const source: LogSourceInfo = {
    path: filePath,
    stream,
    exists: false,
    totalBytes: -1,
    readBytes: 0,
    truncated: false,
    error: "",
  };
  if (!existsSync(filePath)) {
    return { source, entries: [] };
  }
  source.exists = true;

  let fd: number | undefined;
  try {
    source.totalBytes = statSync(filePath).size;
    const size = source.totalBytes;
    fd = openSync(filePath, "r");
    let start = 0;
    if (size > maxBytes) {
      start = snapToLineStart(fd, Math.max(0, size - maxBytes), size);
      source.truncated = true;
    }
    const content = readWindow(fd, start, size).toString("utf8");
    source.readBytes = size - start;
    return { source, entries: parseSlice(content, stream) };
  } catch (cause) {
    source.error = cause instanceof Error ? cause.message : String(cause);
    return { source, entries: [] };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a partially-opened file must not mask the read error.
      }
    }
  }
}

/** Weave slices together while preserving each slice's internal order. */
function mergeSlices(slices: RawEntry[][]): RawEntry[] {
  if (slices.length === 0) {
    return [];
  }
  const allTimestamped = slices.every((slice) => slice.every((entry) => entry.timestamp !== null));
  if (allTimestamped) {
    return slices.flat().sort((a, b) => {
      const timeDiff = (a.timestamp ?? 0) - (b.timestamp ?? 0);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      if (a.stream !== b.stream) {
        return a.stream === "out" ? -1 : 1;
      }
      return a.seq - b.seq;
    });
  }
  // Without trustworthy timestamps the true interleave of stdout/stderr is
  // unknowable; round-robin keeps recency at the bottom and each stream's
  // internal order intact.
  const merged: RawEntry[] = [];
  const cursors = Array.from({ length: slices.length }, () => 0);
  for (;;) {
    let tookAny = false;
    for (let s = 0; s < slices.length; s++) {
      const slice = slices[s];
      const cursor = cursors[s];
      if (slice !== undefined && cursor !== undefined && slice.length > cursor) {
        merged.push(slice[cursor]);
        cursors[s] = cursor + 1;
        tookAny = true;
      }
    }
    if (!tookAny) {
      break;
    }
  }
  return merged;
}

/**
 * Read the tail of each worker capture file across `dirs` and return the most
 * recent `limit` entries after level filtering, oldest first.
 */
export function readWorkerLogs(options: ReadWorkerLogsOptions = {}): WorkerLogsResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxBytes = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const level = options.level ?? "all";
  const dirs = options.dirs ?? [process.cwd()];

  const seenPaths = new Set<string>();
  const sources: LogSourceInfo[] = [];
  const slices: RawEntry[][] = [];

  for (const dir of dirs) {
    for (const candidate of LOG_FILES) {
      const filePath = resolve(join(resolve(dir), candidate.name));
      if (seenPaths.has(filePath)) {
        continue;
      }
      seenPaths.add(filePath);
      const result = readSource(filePath, candidate.stream, maxBytes);
      sources.push(result.source);
      if (result.entries.length > 0) {
        slices.push(result.entries);
      }
    }
  }

  const available = sources.some((source) => source.exists);
  const merged = mergeSlices(slices);

  const windowStart = Math.max(0, merged.length - limit);
  const bounded = merged.slice(windowStart);
  const filtered = level === "all" ? bounded : bounded.filter((entry) => entry.level === level);

  const entries: LogEntry[] = filtered.map((entry, index) => ({
    index,
    timestamp: entry.timestamp,
    level: entry.level,
    stream: entry.stream,
    message: entry.message,
    taskKey: extractTaskKey(entry.message),
  }));

  return {
    available,
    entries,
    sources,
    truncated: sources.some((source) => source.truncated) || windowStart > 0,
  };
}
