/**
 * `devintern worker run-now` — request one immediate workspace drain.
 *
 * The command only writes the `.run-now` sentinel; the running worker consumes
 * it on its next poll tick. Argument parsing and execution are separate so the
 * CLI wrapper can exit and tests can exercise both without `process.exit`.
 */

import { existsSync, statSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { LockManager } from "../lock-manager";
import { loadWorkspaceConfig } from "../workspace/config";
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
 * `--workspace` follows the daemon's contract: a missing, empty, whitespace-only,
 * or `-`-prefixed value is an error, not a silent fallback to the default
 * workspace.
 */
export function parseRunNowArgs(args: string[]): ParsedRunNowArgs {
  let workspacePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--workspace") {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("-")) {
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
 * Whether `path` exists and is a directory.
 *
 * A directory passed to `--workspace` must not pass the config-existence check:
 * `existsSync` is true for directories, so the marker would land in the
 * directory's parent.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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

  const selectedDir =
    parsed.workspacePath !== undefined
      ? dirname(resolve(parsed.workspacePath))
      : resolveWorkspaceDir();
  // `--workspace` names the config file itself, matching `worker add`, the
  // daemon, and `worker login`: a non-standard filename is valid, and a
  // directory is not (otherwise `existsSync` would accept it and the marker
  // would land in its parent).
  const configPath =
    parsed.workspacePath !== undefined
      ? resolve(parsed.workspacePath)
      : workspaceConfigPath(selectedDir);
  if (isDirectory(configPath)) {
    error(`❌ ${configPath} is a directory; pass the path to a workspace config file.`);
    return 1;
  }
  if (!existsSync(configPath)) {
    error(`❌ No workspace.toml at ${configPath}.`);
    return 1;
  }
  const workerRunning =
    LockManager.readLockStatus(selectedDir, ".worker.lock", { plainDir: true })?.running ?? false;

  // An existing file is not necessarily a workspace config: `--workspace
  // ./package.json` would otherwise drop `.run-now` into a random checkout
  // that no worker ever reads. Parse it like `worker add` does so the marker
  // can only land next to a real workspace.
  //
  // A live worker is exempt: it reloads this file itself and keeps the last
  // good config when a reload fails (`config-reload.ts`), so a temporarily
  // invalid file must not block the forced drain this command exists to
  // request. The running worker's in-memory config is authoritative.
  try {
    loadWorkspaceConfig(configPath);
  } catch (loadError) {
    const detail = loadError instanceof Error ? loadError.message : String(loadError);
    if (!workerRunning) {
      error(`❌ Could not read ${configPath}: ${detail}`);
      return 1;
    }
    log(`⚠️  Could not read ${configPath}: ${detail}`);
    log("   A worker is running with its last good config; requesting the drain anyway.");
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

  log(`✅ Run-now requested for ${configPath}`);
  log(`   Marker: ${markerPath}`);
  log("   The worker drains within one poll interval and removes the marker.");
  if (!workerRunning) {
    log("⚠️  No worker is running; the marker stays until the next worker's first poll.");
  }
  return 0;
}
