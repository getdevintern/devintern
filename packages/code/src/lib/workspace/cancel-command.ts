/**
 * `devintern worker cancel <taskKey>` — withdraw a pending ad-hoc task before
 * the worker claims it.
 *
 * Only `pending` rows can be cancelled; a running task is never interrupted.
 * Cancelling only reduces work, so no license check or running worker is
 * needed: the command writes the workspace DB directly.
 */

import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { parseArgs } from "util";

import { InjectedTaskStore } from "../state/injected-tasks";
import { cancelInjectedTask, cancelSucceeded } from "./injected-cancel";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceDbPath } from "./paths";

/** Upper bound on a `--reason`, so the audit column stays a short note. */
export const MAX_CANCEL_REASON_CHARS = 500;

export interface WorkerCancelOptions {
  /** Result sink (defaults to stdout). */
  log?: (message: string) => void;
  /** Failure sink (defaults to stderr). */
  error?: (message: string) => void;
}

export function workerCancelUsage(): string {
  return [
    "Usage: devintern worker cancel <taskKey> [options]",
    "",
    "Cancel a pending ad-hoc task (from `worker add` or the dashboard) before the",
    "worker picks it up. Running tasks cannot be cancelled.",
    "",
    "Options:",
    "  --reason <text>     Note recorded with the cancellation",
    "  --json              Print {taskKey, outcome, message} on stdout",
    "  --workspace <path>  Use this workspace.toml (default: ~/.devintern/)",
    "  -h, --help          Show this help",
    "",
    "Exit status: 0 when the task is cancelled (or already was), 1 otherwise.",
  ].join("\n");
}

type ParsedCancelArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; taskKey: string; reason?: string; json: boolean; workspacePath?: string };

/** Parse `worker cancel` arguments (kept pure for tests). */
export function parseWorkerCancelArgs(args: string[]): ParsedCancelArgs {
  let parsed: ReturnType<typeof parseArgsStrict>;
  try {
    parsed = parseArgsStrict(args);
  } catch (cause) {
    return { kind: "error", message: (cause as Error).message };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (positionals.length !== 1 || !positionals[0]?.trim()) {
    return { kind: "error", message: "worker cancel takes exactly one task key." };
  }
  if (values.reason !== undefined && values.reason.length > MAX_CANCEL_REASON_CHARS) {
    return {
      kind: "error",
      message: `--reason is too long (maximum ${MAX_CANCEL_REASON_CHARS} chars).`,
    };
  }
  return {
    kind: "ok",
    taskKey: positionals[0].trim(),
    reason: values.reason,
    json: values.json ?? false,
    workspacePath: values.workspace,
  };
}

function parseArgsStrict(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      reason: { type: "string" },
      json: { type: "boolean" },
      workspace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/**
 * Cancel a pending ad-hoc task.
 *
 * @returns Process exit code: 0 when the row is (now or already) cancelled
 */
export function runWorkerCancel(args: string[], options: WorkerCancelOptions = {}): number {
  const log = options.log ?? ((message: string) => console.log(message));
  const error = options.error ?? ((message: string) => console.error(message));

  const parsed = parseWorkerCancelArgs(args);
  if (parsed.kind === "help") {
    log(workerCancelUsage());
    return 0;
  }
  if (parsed.kind === "error") {
    error(`❌ ${parsed.message}`);
    error("   Run `devintern worker cancel --help` for usage.");
    return 1;
  }

  const selectedDir = parsed.workspacePath
    ? dirname(resolve(parsed.workspacePath))
    : resolveWorkspaceDir();
  const configPath = parsed.workspacePath
    ? resolve(parsed.workspacePath)
    : workspaceConfigPath(selectedDir);
  if (!existsSync(configPath)) {
    error(`❌ No workspace.toml at ${configPath}.`);
    return 1;
  }

  const store = new InjectedTaskStore(workspaceDbPath(selectedDir));
  try {
    const report = cancelInjectedTask(store, parsed.taskKey, {
      actor: "cli",
      reason: parsed.reason,
    });
    const ok = cancelSucceeded(report.outcome);
    if (parsed.json) {
      log(
        JSON.stringify({
          taskKey: report.taskKey,
          outcome: report.outcome,
          message: report.message,
        }),
      );
    } else if (ok) {
      log(report.outcome === "cancelled" ? report.message : `ℹ️  ${report.message}`);
    } else {
      error(`❌ ${report.message}`);
    }
    return ok ? 0 : 1;
  } catch (cause) {
    error(`❌ Could not cancel ${parsed.taskKey}: ${(cause as Error).message}`);
    return 1;
  } finally {
    store.close();
  }
}
