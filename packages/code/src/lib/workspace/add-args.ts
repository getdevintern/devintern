/**
 * Argument parsing for `devintern worker add`, kept separate from execution
 * so help and arg errors are testable without touching a workspace.
 */

import type { DependencyMode } from "../dependencies/gate";

export interface AddOptions {
  workspacePath?: string;
  repo?: string;
  /** `[[teams]]` entry whose credentials the run uses. */
  team?: string;
  title: string;
  body?: string;
  bodyFile?: string;
  idempotencyKey?: string;
  /** Re-queue this settled ad-hoc task instead of enqueuing a new one. */
  resume?: string;
  wait: boolean;
  json: boolean;
  /** `--wait` deadline in seconds; `0` waits without a limit (default 6h). */
  waitTimeoutSeconds?: number;
  /** `--after` task keys (repeatable), merged with the body's `Depends on:` lines. */
  after: string[];
  /** `--stack` / `--wait-merge` override of `[defaults].dependency_mode`. */
  dependencyMode?: DependencyMode;
}

export type ParsedAddArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; options: AddOptions };

export function workerAddUsage(): string {
  return [
    "Usage: devintern worker add (--title <text> | --resume <taskKey>) [options]",
    "",
    "Enqueue a one-off task against a workspace repo without a tracker ticket.",
    "The running worker runs it through the normal pipeline (checkout, agent,",
    "PR) on its next poll.",
    "",
    "Options:",
    "  --title <text>            Task title (required unless --resume)",
    "  --repo <name>             [[repos]] name to target (default: the only repo)",
    "  --team <name>             Use this [[teams]] entry's credentials (default: the",
    "                            team fixed to the repo, if exactly one)",
    "  --body <text>             Task description",
    "  --body-file <path>        Read the description from a file ('-' for stdin)",
    "  --idempotency-key <key>   Dedupe key; a retry reuses the existing task",
    "  --after <taskKey>         Start only after this ad-hoc task (same repo); repeatable.",
    "                            A 'Depends on: <key>, ...' line in the body works too",
    "  --stack                   Stack on an unmerged dependency's branch once it succeeded",
    "  --wait-merge              Wait until every dependency's PR merged",
    "                            (default: [defaults].dependency_mode, else stacked)",
    "  --resume <taskKey>        Re-queue a settled ad-hoc task (resumes its branch)",
    "  --wait                    Block until the run finishes; exit with its status",
    "  --wait-timeout <seconds>  Give up waiting after this long (0 = no limit; default 21600)",
    "  --json                    Emit a machine-readable result on stdout",
    "  --workspace <path>        Use this workspace.toml (default: ~/.devintern/)",
    "  -h, --help                Show this help",
  ].join("\n");
}

/** Flag names that require a following value. */
const VALUE_FLAGS = new Set([
  "--workspace",
  "--repo",
  "--team",
  "--title",
  "--body",
  "--body-file",
  "--idempotency-key",
  "--resume",
  "--wait-timeout",
  "--after",
]);

/**
 * Validate the `--resume` form.
 *
 * The row already holds its title, body, repo, and idempotency key; passing
 * them again would silently disagree with what the worker will run.
 *
 * @returns An error message, or null when the arguments are acceptable
 */
function validateResumeArgs(options: AddOptions): string | null {
  if (options.resume === undefined) return null;
  if (!options.resume.trim()) {
    return "--resume requires a task key.";
  }
  const conflicting = [
    options.title.trim() ? "--title" : undefined,
    options.body !== undefined ? "--body" : undefined,
    options.bodyFile !== undefined ? "--body-file" : undefined,
    options.repo !== undefined ? "--repo" : undefined,
    options.team !== undefined ? "--team" : undefined,
    options.idempotencyKey !== undefined ? "--idempotency-key" : undefined,
    options.after.length > 0 ? "--after" : undefined,
    options.dependencyMode === "stacked" ? "--stack" : undefined,
    options.dependencyMode === "merged" ? "--wait-merge" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (conflicting.length > 0) {
    return `--resume re-queues the existing task; drop ${conflicting.join(", ")}.`;
  }
  return null;
}

/**
 * Store one value flag on the parsed options.
 *
 * @returns An error message for an invalid value, else null
 */
function applyValueFlag(options: AddOptions, flag: string, value: string): string | null {
  switch (flag) {
    case "--workspace":
      options.workspacePath = value;
      break;
    case "--repo":
      options.repo = value;
      break;
    case "--team":
      options.team = value;
      break;
    case "--title":
      options.title = value;
      break;
    case "--body":
      options.body = value;
      break;
    case "--body-file":
      options.bodyFile = value;
      break;
    case "--idempotency-key":
      options.idempotencyKey = value;
      break;
    case "--resume":
      options.resume = value;
      break;
    case "--after":
      if (!value.trim()) return "--after requires a task key.";
      options.after.push(value.trim());
      break;
    case "--wait-timeout": {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 0) {
        return "--wait-timeout requires a non-negative integer number of seconds.";
      }
      options.waitTimeoutSeconds = seconds;
      break;
    }
  }
  return null;
}

/**
 * Parse `worker add` arguments. Kept separate from execution so help and arg
 * errors are testable without touching a workspace.
 */
export function parseWorkerAddArgs(args: string[]): ParsedAddArgs {
  const options: AddOptions = { title: "", wait: false, json: false, after: [] };
  let modeFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--stack" || arg === "--wait-merge") {
      const mode: DependencyMode = arg === "--stack" ? "stacked" : "merged";
      if (modeFlag !== undefined && options.dependencyMode !== mode) {
        return { kind: "error", message: "--stack and --wait-merge are mutually exclusive." };
      }
      modeFlag = arg;
      options.dependencyMode = mode;
      continue;
    }
    if (arg === "--wait") {
      options.wait = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      // `--body-file -` is the documented stdin sentinel; other flags reject
      // a leading dash so a forgotten value cannot swallow the next flag.
      const allowDash = arg === "--body-file";
      if (value === undefined || (!allowDash && value.startsWith("-"))) {
        return { kind: "error", message: `${arg} requires a value.` };
      }
      i++;
      const valueError = applyValueFlag(options, arg, value);
      if (valueError) return { kind: "error", message: valueError };
      continue;
    }
    return { kind: "error", message: `Unknown option: ${arg}` };
  }

  const resumeError = validateResumeArgs(options);
  if (resumeError) {
    return { kind: "error", message: resumeError };
  }
  if (options.resume !== undefined) {
    return { kind: "ok", options };
  }
  if (!options.title.trim()) {
    return { kind: "error", message: "--title is required and cannot be empty." };
  }
  if (options.body !== undefined && options.bodyFile !== undefined) {
    return { kind: "error", message: "--body and --body-file are mutually exclusive." };
  }
  if (options.idempotencyKey !== undefined && !options.idempotencyKey.trim()) {
    return { kind: "error", message: "--idempotency-key cannot be empty." };
  }
  return { kind: "ok", options };
}
