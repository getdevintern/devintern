/**
 * Local audit and retry spool for bug reports.
 *
 * Every manual report is written before submission so a failed request leaves
 * a copy the user can retry (`devintern report --from <path>`). Automatic
 * reports keep a small fingerprint ledger so a crash loop cannot spam the
 * endpoint.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BugReportPayload, SubmittedReport } from "./types";

export interface SpoolEntry {
  version: 1;
  savedAt: string;
  status: "pending" | "submitted";
  receipt?: string;
  url?: string;
  submittedAt?: string;
  error?: string;
  payload: BugReportPayload;
}

export interface AutoReportState {
  version: 1;
  reports: Array<{ fingerprint: string; at: string }>;
}

const AUTO_STATE_FILE = ".auto.json";
const MAX_AUTO_STATE_ENTRIES = 100;

/** Ensure the report directory exists with owner-only permissions. */
export function ensureReportDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Minimal structural check for a payload loaded from disk or stdin. */
export function isBugReportPayload(value: unknown): value is BugReportPayload {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === 1 &&
    typeof record.reportId === "string" &&
    record.reportId.trim().length > 0 &&
    typeof record.title === "string" &&
    typeof record.description === "string" &&
    record.environment !== null &&
    typeof record.environment === "object"
  );
}

/** Check whether a parsed value is a spool entry. */
export function isSpoolEntry(value: unknown): value is SpoolEntry {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.savedAt === "string" &&
    (record.status === "pending" || record.status === "submitted") &&
    isBugReportPayload(record.payload)
  );
}

/** Filesystem-safe fragment of a report id. */
function safeId(reportId: string): string {
  return reportId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "report";
}

/** Write JSON atomically with owner-only permissions. */
function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/** Persist a report and return the file path. */
export function saveSpoolEntry(
  dir: string,
  payload: BugReportPayload,
  options: {
    status?: "pending" | "submitted";
    receipt?: string;
    url?: string;
    error?: string;
    savedAt?: Date;
  } = {},
): string {
  ensureReportDir(dir);
  const savedAt = (options.savedAt ?? new Date()).toISOString();
  const stamp = savedAt.replace(/[:.]/g, "-");
  const path = join(dir, `report-${stamp}-${safeId(payload.reportId)}.json`);
  const entry: SpoolEntry = {
    version: 1,
    savedAt,
    status: options.status ?? "pending",
    payload,
    ...(options.receipt ? { receipt: options.receipt } : {}),
    ...(options.url ? { url: options.url } : {}),
    ...(options.status === "submitted" ? { submittedAt: savedAt } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
  writeJson(path, entry);
  return path;
}

/** Read a payload or spool entry from a file. */
export function readSpoolFile(path: string): SpoolEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isSpoolEntry(parsed)) return parsed;
    if (isBugReportPayload(parsed)) {
      return {
        version: 1,
        savedAt: new Date().toISOString(),
        status: "pending",
        payload: parsed,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** List spool entries, newest first, skipping unreadable files. */
export function listSpoolEntries(dir: string): SpoolEntry[] {
  if (!existsSync(dir)) return [];
  const entries: SpoolEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const entry = readSpoolFile(join(dir, name));
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Find a spool entry by full or partial report id. */
export function findSpoolEntry(dir: string, idPrefix: string): SpoolEntry | null {
  return findSpoolEntryFile(dir, idPrefix)?.entry ?? null;
}

/** Find a spool entry and the file backing it. */
export function findSpoolEntryFile(
  dir: string,
  idPrefix: string,
): { path: string; entry: SpoolEntry } | null {
  const needle = idPrefix.trim().toLowerCase();
  if (!needle || !existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = join(dir, name);
    const entry = readSpoolFile(path);
    if (entry && entry.payload.reportId.toLowerCase().startsWith(needle)) {
      return { path, entry };
    }
  }
  return null;
}

/** Attach the last submission error to an existing spool entry. */
export function markSpoolError(dir: string, reportId: string, error: string): void {
  const found = findSpoolEntryFile(dir, reportId);
  if (!found) return;
  writeJson(found.path, { ...found.entry, error } satisfies SpoolEntry);
}

/** Rewrite matching spool entries as submitted. Best-effort. */
export function markSpoolSubmitted(dir: string, reportId: string, result: SubmittedReport): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = join(dir, name);
    const entry = readSpoolFile(path);
    if (entry?.payload.reportId !== reportId) continue;
    const next: SpoolEntry = {
      ...entry,
      status: "submitted",
      submittedAt: new Date().toISOString(),
      ...(result.receipt ? { receipt: result.receipt } : {}),
      ...(result.url ? { url: result.url } : {}),
    };
    delete next.error;
    writeJson(path, next);
  }
}

/** Delete pending entries older than `maxAgeDays`; submitted receipts too. */
export function pruneSpool(dir: string, maxAgeDays = 30, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      // Best effort.
    }
  }
  return removed;
}

/** Read the automatic-report fingerprint ledger. */
export function readAutoState(dir: string): AutoReportState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, AUTO_STATE_FILE), "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === 1 &&
      Array.isArray((parsed as { reports?: unknown }).reports)
    ) {
      const reports = (parsed as AutoReportState).reports.filter(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as { fingerprint?: unknown }).fingerprint === "string" &&
          typeof (item as { at?: unknown }).at === "string",
      );
      return { version: 1, reports };
    }
  } catch {
    // Missing or malformed state starts fresh.
  }
  return { version: 1, reports: [] };
}

/** Persist the automatic-report ledger, bounded in size. */
function writeAutoState(dir: string, state: AutoReportState): void {
  ensureReportDir(dir);
  const reports = state.reports.slice(-MAX_AUTO_STATE_ENTRIES);
  writeJson(join(dir, AUTO_STATE_FILE), { version: 1, reports });
}

export interface AutoReportGateOptions {
  dedupeHours?: number;
  maxPerDay?: number;
  now?: Date;
}

/**
 * Check and reserve a slot for an automatic report.
 *
 * The reservation is recorded immediately so two consecutive crash-loop
 * attempts in one process cannot both send. Callers should only reserve after
 * classification decided the failure is worth reporting.
 */
export function reserveAutoReport(
  dir: string,
  fingerprint: string,
  options: AutoReportGateOptions = {},
): boolean {
  const now = options.now ?? new Date();
  const dedupeMs = (options.dedupeHours ?? 24) * 60 * 60 * 1000;
  const maxPerDay = options.maxPerDay ?? 5;
  const state = readAutoState(dir);
  const recent = state.reports.filter(
    (item) => now.getTime() - Date.parse(item.at) <= 7 * 24 * 60 * 60 * 1000,
  );
  if (
    recent.some(
      (item) => item.fingerprint === fingerprint && now.getTime() - Date.parse(item.at) < dedupeMs,
    )
  ) {
    writeAutoState(dir, { version: 1, reports: recent });
    return false;
  }
  const lastDay = recent.filter(
    (item) => now.getTime() - Date.parse(item.at) < 24 * 60 * 60 * 1000,
  );
  if (lastDay.length >= maxPerDay) {
    writeAutoState(dir, { version: 1, reports: recent });
    return false;
  }
  writeAutoState(dir, {
    version: 1,
    reports: [...recent, { fingerprint, at: now.toISOString() }],
  });
  return true;
}
