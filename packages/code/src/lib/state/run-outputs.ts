/**
 * Run outputs: structured records of the work an agent run created outside
 * itself (ad-hoc tasks it delegated, tracker tickets it filed).
 *
 * While a run is active the pipeline exports {@link RUN_ID_ENV} and
 * {@link RUN_OUTPUTS_ENV} to every harness it spawns. Tools the agent calls
 * (`devintern worker add`, later `devpm`) append one JSON object per line to
 * the outputs file; when the run finishes the recorder parses the file and
 * stores the records in the `run_outputs` table, which the dashboard reads to
 * show a run's lineage.
 *
 * Format (version 1), one object per line:
 *
 * ```jsonl
 * {"v":1,"kind":"tracker_issue","tracker":"jira","key":"DEV-210","url":"https://…","title":"…"}
 * {"v":1,"kind":"injected_task","id":132,"taskKey":"local-fix-login","title":"…"}
 * ```
 *
 * `v` and `kind` are required on every line. `tracker_issue` requires `key`;
 * `injected_task` requires `id` and `taskKey`. Other fields are optional.
 * Unknown versions, unknown kinds, and malformed lines are skipped (and
 * logged) so a bad line can never fail the run.
 */

import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { dirname } from "path";

/** Env var carrying the active run's `runs.id` into spawned harnesses. */
export const RUN_ID_ENV = "DEVINTERN_RUN_ID";
/** Env var carrying the path of the active run's outputs JSONL file. */
export const RUN_OUTPUTS_ENV = "DEVINTERN_RUN_OUTPUTS";
/** Current record format version. */
export const RUN_OUTPUT_VERSION = 1;

/** Kinds of output a run can record. */
export type RunOutputKind = "tracker_issue" | "injected_task";

/** A tracker ticket the run filed. */
export interface TrackerIssueOutput {
  kind: "tracker_issue";
  /** Tracker type (`jira`, `linear`, …), when known. */
  tracker?: string;
  /** Tracker-assigned key, e.g. `DEV-210`. */
  key: string;
  /** Web URL (http/https only). */
  url?: string;
  title?: string;
}

/** An ad-hoc task the run delegated with `devintern worker add`. */
export interface InjectedTaskOutput {
  kind: "injected_task";
  /** `injected_tasks.id`. */
  id: number;
  taskKey: string;
  title?: string;
  repo?: string;
}

/** One parsed outputs record. */
export type RunOutputRecord = TrackerIssueOutput | InjectedTaskOutput;

/** A record as stored in `run_outputs`. */
export interface StoredRunOutput {
  runId: number;
  kind: RunOutputKind;
  /** Tracker key or ad-hoc task key. */
  refKey: string;
  url?: string;
  title?: string;
  record: RunOutputRecord;
  createdAt: number;
}

export type ParsedRunOutputLine =
  | { ok: true; record: RunOutputRecord }
  | { ok: false; error: string };

/** Longest stored string field; longer values are truncated. */
const MAX_FIELD_CHARS = 500;
const MAX_URL_CHARS = 2000;
/** Outputs files above this size are read only up to the limit. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Records ingested per run; the rest are skipped. */
const MAX_RECORDS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** An http(s) URL, or undefined: other schemes are never rendered as links. */
function optionalUrl(value: unknown): string | undefined {
  const text = optionalText(value, MAX_URL_CHARS);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse one outputs line into a {@link RunOutputRecord}.
 *
 * @param line - One line of the outputs file (untrusted)
 */
export function parseRunOutputLine(line: string): ParsedRunOutputLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (!isRecord(raw)) return { ok: false, error: "not a JSON object" };
  if (raw.v !== RUN_OUTPUT_VERSION) {
    return { ok: false, error: `unsupported version ${JSON.stringify(raw.v)}` };
  }
  if (raw.kind === "tracker_issue") {
    const key = optionalText(raw.key);
    if (!key) return { ok: false, error: "tracker_issue requires a non-empty key" };
    const tracker = optionalText(raw.tracker, 50);
    const url = optionalUrl(raw.url);
    const title = optionalText(raw.title);
    return {
      ok: true,
      record: {
        kind: "tracker_issue",
        key,
        ...(tracker ? { tracker } : {}),
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
      },
    };
  }
  if (raw.kind === "injected_task") {
    const id = raw.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return { ok: false, error: "injected_task requires a positive integer id" };
    }
    const taskKey = optionalText(raw.taskKey);
    if (!taskKey) return { ok: false, error: "injected_task requires a non-empty taskKey" };
    const title = optionalText(raw.title);
    const repo = optionalText(raw.repo);
    return {
      ok: true,
      record: {
        kind: "injected_task",
        id,
        taskKey,
        ...(title ? { title } : {}),
        ...(repo ? { repo } : {}),
      },
    };
  }
  return { ok: false, error: `unknown kind ${JSON.stringify(raw.kind)}` };
}

/** Result of parsing a whole outputs file. */
export interface ParsedRunOutputs {
  records: RunOutputRecord[];
  /** 1-based line numbers that were skipped, with the reason. */
  skipped: Array<{ line: number; error: string }>;
}

/**
 * Parse an outputs file's text. Blank lines are ignored; malformed lines and
 * lines beyond the record cap are reported in `skipped`.
 *
 * @param text - Outputs file contents (untrusted)
 */
export function parseRunOutputs(text: string): ParsedRunOutputs {
  const records: RunOutputRecord[] = [];
  const skipped: ParsedRunOutputs["skipped"] = [];
  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (records.length >= MAX_RECORDS) {
      skipped.push({ line: index + 1, error: `more than ${MAX_RECORDS} records` });
      continue;
    }
    const parsed = parseRunOutputLine(line);
    if (parsed.ok) records.push(parsed.record);
    else skipped.push({ line: index + 1, error: parsed.error });
  }
  return { records, skipped };
}

/** Serialize a record as one outputs line (without the trailing newline). */
export function serializeRunOutput(record: RunOutputRecord): string {
  return JSON.stringify({ v: RUN_OUTPUT_VERSION, ...record });
}

/**
 * Append a record to an outputs file, creating its directory when needed.
 * Throws on filesystem errors; callers decide whether that matters.
 *
 * @param path - Outputs file (usually from {@link RUN_OUTPUTS_ENV})
 * @param record - Record to append
 */
export function appendRunOutput(path: string, record: RunOutputRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${serializeRunOutput(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Parse a run id from an env value or flag: a positive decimal integer, else
 * undefined.
 *
 * @param raw - Untrusted value
 */
export function parseRunId(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Env overlay that exposes a run's identity and outputs file to a harness. */
export function runIdentityEnv(runId: number, outputsPath: string): Record<string, string> {
  return { [RUN_ID_ENV]: String(runId), [RUN_OUTPUTS_ENV]: outputsPath };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Create the `run_outputs` table and its indexes (idempotent). */
export function initRunOutputsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS run_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ref_key TEXT NOT NULL,
      url TEXT,
      title TEXT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  // One row per (run, kind, ref): an agent that reports the same ticket twice
  // still gets one entry.
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_run_outputs_ref ON run_outputs(run_id, kind, ref_key)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_run_outputs_kind_ref ON run_outputs(kind, ref_key)");
}

function refKeyOf(record: RunOutputRecord): string {
  return record.kind === "tracker_issue" ? record.key : record.taskKey;
}

/**
 * Store records for a run; duplicates of an existing (kind, ref) are ignored.
 *
 * @returns Number of rows inserted
 */
export function insertRunOutputs(
  db: Database,
  runId: number,
  records: readonly RunOutputRecord[],
  now: number = Date.now(),
): number {
  if (records.length === 0) return 0;
  const insert = db.query(
    `INSERT OR IGNORE INTO run_outputs (run_id, kind, ref_key, url, title, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  db.transaction(() => {
    for (const record of records) {
      const result = insert.run(
        runId,
        record.kind,
        refKeyOf(record),
        record.kind === "tracker_issue" ? (record.url ?? null) : null,
        record.title ?? null,
        serializeRunOutput(record),
        now,
      );
      inserted += result.changes;
    }
  })();
  return inserted;
}

interface RunOutputRow {
  run_id: number;
  kind: string;
  ref_key: string;
  url: string | null;
  title: string | null;
  data: string;
  created_at: number;
}

/** Decode a stored row; a row whose payload no longer parses is dropped. */
function rowToStoredOutput(row: RunOutputRow): StoredRunOutput | null {
  const parsed = parseRunOutputLine(row.data);
  if (!parsed.ok) return null;
  return {
    runId: row.run_id,
    kind: parsed.record.kind,
    refKey: row.ref_key,
    ...(row.url ? { url: row.url } : {}),
    ...(row.title ? { title: row.title } : {}),
    record: parsed.record,
    createdAt: row.created_at,
  };
}

function decodeRows(rows: RunOutputRow[]): StoredRunOutput[] {
  return rows.map(rowToStoredOutput).filter((row): row is StoredRunOutput => row !== null);
}

/** Records stored for a run, oldest first. */
export function listRunOutputs(db: Database, runId: number): StoredRunOutput[] {
  return decodeRows(
    db.query("SELECT * FROM run_outputs WHERE run_id = ? ORDER BY id").all(runId) as RunOutputRow[],
  );
}

/**
 * The run that recorded an `injected_task` output with this task key, if any.
 * Survives the settled `injected_tasks` row being pruned.
 */
export function findInjectedTaskOutputParent(db: Database, taskKey: string): number | undefined {
  const row = db
    .query(
      "SELECT run_id FROM run_outputs WHERE kind = 'injected_task' AND ref_key = ? ORDER BY id LIMIT 1",
    )
    .get(taskKey) as { run_id: number } | null;
  return row?.run_id;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/** Read at most {@link MAX_FILE_BYTES} of a file as UTF-8. */
function readCapped(path: string): string {
  return readFileSync(path).subarray(0, MAX_FILE_BYTES).toString("utf8");
}

/**
 * Parse a finished run's outputs file into `run_outputs`, then remove the
 * file. Never throws: a missing file is a no-op, malformed lines are skipped
 * with a log line, and storage errors are logged.
 *
 * @param store - Writes the parsed records for the run
 * @param runId - Finished run
 * @param path - The run's outputs file
 * @param log - Diagnostic sink (defaults to `console.warn`)
 * @returns Number of records stored
 */
export function ingestRunOutputsFile(
  store: { addRunOutputs(runId: number, records: readonly RunOutputRecord[]): number },
  runId: number,
  path: string,
  log: (message: string) => void = (message) => console.warn(message),
): number {
  try {
    if (!existsSync(path)) return 0;
    const { records, skipped } = parseRunOutputs(readCapped(path));
    for (const entry of skipped) {
      log(`⚠️  Run ${runId} outputs line ${entry.line} skipped: ${entry.error}`);
    }
    const stored = store.addRunOutputs(runId, records);
    try {
      unlinkSync(path);
    } catch {
      // Removal is housekeeping; a leftover file is harmless.
    }
    return stored;
  } catch (error) {
    log(`⚠️  Could not ingest run ${runId} outputs: ${(error as Error).message}`);
    return 0;
  }
}
