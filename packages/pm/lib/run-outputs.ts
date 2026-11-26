/**
 * Report created tracker tickets to the DevIntern run that invoked `devpm`.
 *
 * Inside a DevIntern agent run the worker exports `DEVINTERN_RUN_ID` and
 * `DEVINTERN_RUN_OUTPUTS` (path to a per-run JSONL file). Each ticket `devpm`
 * creates appends one `tracker_issue` line there; the worker ingests the file
 * when the run ends and lists the tickets under "Spawned work". The line format
 * (version 1) is owned by `packages/code/src/lib/state/run-outputs.ts`:
 *
 * ```jsonl
 * {"v":1,"kind":"tracker_issue","tracker":"jira","key":"DEV-210","url":"https://…","title":"…","parentRunId":42}
 * ```
 *
 * Recording is best-effort: a write failure warns on stderr and never fails
 * ticket creation. With `DEVINTERN_RUN_OUTPUTS` unset nothing is written.
 */

import { appendFile } from "./runtime/fs.js";

/** Env var carrying the active run's id. */
export const RUN_ID_ENV = "DEVINTERN_RUN_ID";
/** Env var carrying the path of the active run's outputs JSONL file. */
export const RUN_OUTPUTS_ENV = "DEVINTERN_RUN_OUTPUTS";

/** A created ticket as reported to the parent run. */
export interface CreatedTicketOutput {
  /** Tracker type from config (`jira`, `linear`, `markdown`, …). */
  tracker: string;
  key: string;
  /** Tracker URL; non-http(s) values (markdown file paths) are omitted. */
  url?: string;
  title?: string;
}

export interface RecordTicketDeps {
  env?: NodeJS.ProcessEnv;
  /** Receives the warning when the outputs file cannot be written. */
  warn?: (message: string) => void;
}

/** Positive integer run id, matching how the worker parses `DEVINTERN_RUN_ID`. */
function parseRunId(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the JSONL line for a created ticket.
 *
 * @param ticket - Created ticket details
 * @param parentRunId - `DEVINTERN_RUN_ID`, when set
 */
export function formatTrackerIssueLine(ticket: CreatedTicketOutput, parentRunId?: number): string {
  const url = httpUrl(ticket.url);
  const title = ticket.title?.trim();
  const record = {
    v: 1,
    kind: "tracker_issue",
    tracker: ticket.tracker,
    key: ticket.key,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(parentRunId !== undefined ? { parentRunId } : {}),
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * Append a `tracker_issue` record for a created ticket when running inside a
 * DevIntern run. Never throws.
 *
 * @param ticket - Created ticket details
 * @param deps - Injectable env and warning sink (tests)
 */
export async function recordCreatedTicket(
  ticket: CreatedTicketOutput,
  deps: RecordTicketDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const path = env[RUN_OUTPUTS_ENV]?.trim();
  if (!path || !ticket.key.trim()) return;
  const parentRunId = parseRunId(env[RUN_ID_ENV]);
  try {
    await appendFile(path, formatTrackerIssueLine(ticket, parentRunId));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const warn = deps.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    warn(`Warning: could not record ${ticket.key} in ${RUN_OUTPUTS_ENV} (${path}): ${reason}`);
  }
}
