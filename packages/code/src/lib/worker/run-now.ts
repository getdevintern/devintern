/**
 * `devintern worker run-now` — request one immediate workspace drain.
 *
 * The command only writes the `.run-now` sentinel; the running worker consumes
 * it on its next poll tick. Argument parsing and execution are separate so the
 * CLI wrapper can exit and tests can exercise both without `process.exit`.
 */

import { existsSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { LockManager } from "../lock-manager";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceRunNowPath } from "../workspace/paths";

/** Parsed `worker run-now` arguments. */
export type ParsedRunNowArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; workspacePath?: string };

export interface RunNowOptions {
  /** Human-readable status sink (defaults to stdout). */
  log?: (message: string) => void;
  /** Failure sink (defaults to stderr). */
  error?: (message: string) => void;
}

/** Help text for `worker run-now`. */
export function runNowUsage(): string {
  return [
    "Usage: devintern worker run-now [--workspace <path>]",
    "",
    "Ask the running workspace worker to drain ready tasks now,",
    "ignoring working windows (quiet hours) for this one pass.",
    "The worker picks up the request on its next poll interval",
    "(default 60s) and deletes the marker once served.",
  ].join("\n");
}

/**
 * Parse `worker run-now` arguments.
 *
 * `--workspace` follows the daemon's contract: a missing value or a value that
 * starts with `-` is an error, not a silent fallback to the default workspace.
 */
export function parseRunNowArgs(args: string[]): ParsedRunNowArgs {
  let workspacePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--workspace") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { kind: "error", message: "--workspace requires a path to workspace.toml." };
      }
      workspacePath = value;
      i++;
      continue;
    }
    return { kind: "error", message: `Unknown option: ${arg}` };
  }
  return { kind: "ok", workspacePath };
}

/**
 * Write the run-now marker for the selected workspace.
 *
 * @returns Process exit code (0 when the marker was written, 1 otherwise).
 */
export function runWorkerRunNow(args: string[], options: RunNowOptions = {}): number {
  const log = options.log ?? ((message: string) => console.log(message));
  const error = options.error ?? ((message: string) => console.error(message));

  const parsed = parseRunNowArgs(args);
  if (parsed.kind === "help") {
    log(runNowUsage());
    return 0;
  }
  if (parsed.kind === "error") {
    error(`❌ ${parsed.message}`);
    if (parsed.message.startsWith("Unknown option:")) {
      error("   Run 'devintern worker run-now --help' for usage.");
    }
    return 1;
  }

  const selectedDir = parsed.workspacePath
    ? dirname(resolve(parsed.workspacePath))
    : resolveWorkspaceDir();
  const configPath = workspaceConfigPath(selectedDir);
  if (!existsSync(configPath)) {
    error(`❌ No workspace.toml at ${configPath}.`);
    return 1;
  }

  const markerPath = workspaceRunNowPath(selectedDir);
  try {
    writeFileSync(markerPath, "");
  } catch (writeError) {
    // A raw Node error here is a minified bundle stack with one actionable
    // line buried in it. Report the marker and the fix instead.
    const detail = writeError instanceof Error ? writeError.message : String(writeError);
    error(`❌ Could not request a run-now drain: ${detail}`);
    error(`   Marker: ${markerPath}`);
    error("   The workspace directory must be writable by this process.");
    error("   Under a sandbox, add it to AGENT_SANDBOX_WRITABLE_PATHS.");
    return 1;
  }

  const workerRunning =
    LockManager.readLockStatus(selectedDir, ".worker.lock", { plainDir: true })?.running ?? false;
  log(`✅ Run-now requested for ${configPath}`);
  log(`   Marker: ${markerPath}`);
  log("   The worker drains within one poll interval and removes the marker.");
  if (!workerRunning) {
    log("⚠️  No worker is running; the marker stays until the next worker's first poll.");
  }
  return 0;
}
