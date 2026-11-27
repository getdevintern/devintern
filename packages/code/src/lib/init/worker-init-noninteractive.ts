/**
 * `devintern worker init --non-interactive`: flag-driven worker setup for
 * coding agents, provisioning scripts, and SSH sessions without a TTY.
 *
 * Runs the wizard's steps (`worker-init-steps.ts`) with flags and the
 * environment as the input source: tracker, `[defaults].task_query`, the
 * current repository, and tracker credentials (environment or a 0600
 * `--env-file`) are validated, saved atomically, and checked like
 * `devintern worker doctor`. Sign-in, relay pairing, and the background
 * service become next steps. This module parses the flags, finishes the
 * report (rollback, next steps, result), and redacts secrets from it.
 */

import { rmSync } from "fs";
import { resolve } from "path";

import type { PendingSignIn } from "../account/cli";
import { parseSignInMethod } from "../account/login-args";
import { shellQuote, workspaceEnvPrefixFor } from "../account/worker-pilot";
import type { ReadinessCheck } from "../observability/readiness";
import {
  blockerNextSteps,
  connectStep,
  failureCodeFor,
  readinessExitCode,
  resultFor,
  serviceStep,
} from "../observability/readiness-json";
import type { ReadinessResult } from "../observability/readiness-json";
import { parseEnvFile } from "../workspace/env";
import { resolveWorkspaceDir, workspaceEnvPath } from "../workspace/paths";
import { errorMessage } from "./worker-init-fs";
import { rollbackWrites } from "./worker-init-noninteractive-plan";
import type { Plan } from "./worker-init-noninteractive-plan";
import {
  WORKER_INIT_JSON_SCHEMA,
  WORKER_INIT_JSON_VERSION,
} from "./worker-init-noninteractive-types";
import type {
  Env,
  InitCheck,
  InitNextStep,
  InitResult,
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
  NonInteractiveInitReport,
} from "./worker-init-noninteractive-types";
import { emptyOutcome, secretValues } from "./worker-init-run";
import type { FlagsRun } from "./worker-init-run";
import { initRerunCommand, runWorkerInitSteps } from "./worker-init-steps";

export { readEnvFile, wrongQueryLanguage } from "./worker-init-noninteractive-plan";
export { initRerunCommand } from "./worker-init-steps";
export {
  WORKER_INIT_JSON_SCHEMA,
  WORKER_INIT_JSON_VERSION,
} from "./worker-init-noninteractive-types";
export type {
  InitCheck,
  InitErrorCode,
  InitNextStep,
  InitRepo,
  InitResult,
  NonInteractiveInitArgs,
  NonInteractiveInitDeps,
  NonInteractiveInitReport,
} from "./worker-init-noninteractive-types";
export {
  WORKER_INIT_LOCK_FILE,
  acquireWorkspaceInitLock,
  condenseMessage,
  removeStaleLock,
} from "./worker-init-fs";

export type { CheckStatus } from "../observability/readiness-json";

/** Exit code for a report: 0 success or unchanged, 2 action required, 1 failure. */
export function initExitCode(result: InitResult): number {
  return result === "unchanged" ? 0 : readinessExitCode(result);
}

const USAGE_HINT = "Run `devintern worker init --help` for options.";

/** Parse result: flags, or one error message (`json` tells the caller how to print it). */
export type ParseResult =
  | { ok: true; args: NonInteractiveInitArgs }
  | { ok: false; error: string; json: boolean };

/**
 * Parse `worker init --non-interactive` flags. Secrets are never accepted as
 * flags: anything unknown (e.g. `--jira-token`) is rejected and the error
 * points to the environment and `--env-file`.
 */
export function parseNonInteractiveInitArgs(argv: string[]): ParseResult {
  const args: NonInteractiveInitArgs = { repoFromCwd: false, json: false, yes: false };
  const json = argv.includes("--json");
  const valueFlags: Record<string, "tracker" | "taskQuery" | "envFile"> = {
    "--tracker": "tracker",
    "--task-query": "taskQuery",
    "--env-file": "envFile",
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const field = valueFlags[flag];
    if (field) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[i + 1];
      if (value === undefined || (eq < 0 && value.startsWith("--")) || value.trim() === "") {
        return { ok: false, json, error: `${flag} requires a value. ${USAGE_HINT}` };
      }
      args[field] = value;
      if (eq < 0) i++;
      continue;
    }
    if (flag === "--sign-in") {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[i + 1];
      if (eq < 0) i++;
      const signIn = parseSignInMethod(value);
      if (!signIn.ok) return { ok: false, json, error: signIn.error };
      args.signIn = signIn.login;
      continue;
    }
    if (eq > 0) {
      return { ok: false, json, error: unknownOptionMessage(flag) };
    }
    switch (raw) {
      case "--non-interactive":
        break;
      case "--repo-from-cwd":
        args.repoFromCwd = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--remove-env-file":
        args.removeEnvFile = true;
        break;
      case "--no-service":
        // Non-interactive init never installs the service; accepted for symmetry.
        break;
      case "--customize":
        return {
          ok: false,
          json,
          error:
            "--customize asks each worker setting and needs a terminal; it cannot be combined " +
            `with --non-interactive. Edit workspace.toml instead. ${USAGE_HINT}`,
        };
      default:
        return {
          ok: false,
          json,
          error: raw.startsWith("-")
            ? unknownOptionMessage(raw)
            : `Unexpected argument: ${raw}. ${USAGE_HINT}`,
        };
    }
  }
  if (args.removeEnvFile && !args.envFile) {
    return { ok: false, json, error: `--remove-env-file needs --env-file <path>. ${USAGE_HINT}` };
  }
  return { ok: true, args };
}

function unknownOptionMessage(flag: string): string {
  return (
    `Unknown option: ${flag}. Secrets are never accepted as flags: export them in the ` +
    "environment or put them in a file passed with --env-file <path> (mode 0600). " +
    USAGE_HINT
  );
}

/** Replace every secret value from `env` that occurs in `text`. */
export function redactSecrets(text: string, secrets: string[]): string {
  let next = text;
  for (const secret of secrets) {
    if (secret.length >= 4) next = next.split(secret).join("***");
  }
  return next;
}

export { resultFor };

/** A `failure` report with nothing set yet. */
export function emptyInitReport(workspaceDir: string): NonInteractiveInitReport {
  return {
    schema: WORKER_INIT_JSON_SCHEMA,
    version: WORKER_INIT_JSON_VERSION,
    result: "failure",
    workspaceDir,
    tracker: null,
    taskQuery: null,
    repo: null,
    filesWritten: [],
    changed: false,
    persisted: false,
    warnings: [],
    checks: [],
    nextSteps: [],
  };
}

/**
 * Redact secrets from every string in the report except the structured
 * `tracker`, `taskQuery`, and `repo` fields, which are non-secret by design
 * (`repo.remote` already has URL credentials stripped) and which `--json`
 * consumers parse.
 */
function redactReport(
  report: NonInteractiveInitReport,
  secrets: string[],
): NonInteractiveInitReport {
  if (secrets.length === 0) return report;
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecrets(value, secrets);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    }
    return value;
  };
  const redacted = redact(report) as NonInteractiveInitReport;
  return { ...redacted, tracker: report.tracker, taskQuery: report.taskQuery, repo: report.repo };
}

/**
 * Failure report for an error raised outside {@link runNonInteractiveWorkerInit}
 * (for example while loading the environment), with secrets from `env` redacted.
 */
export function unexpectedFailureReport(
  workspaceDir: string,
  error: unknown,
  env: Env = process.env,
): NonInteractiveInitReport {
  return redactReport(
    { ...emptyInitReport(workspaceDir), code: "unexpected_error", error: errorMessage(error) },
    secretValues(env),
  );
}

/**
 * Run non-interactive worker setup end to end. Never prompts, opens a
 * browser, installs a service, or starts the worker.
 *
 * Re-running with the same flags changes nothing and reports `unchanged`. A
 * run whose tracker, query, or repository check fails restores what it
 * wrote, so a rejected query or credential never stays in the workspace (a
 * running worker may briefly reload it while the checks run).
 *
 * @returns The report; `result` is `failure` (with a `code`) on bad input or any failed check
 */
export async function runNonInteractiveWorkerInit(
  args: NonInteractiveInitArgs,
  deps: NonInteractiveInitDeps = {},
): Promise<NonInteractiveInitReport> {
  const processEnv = deps.processEnv ?? process.env;
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  const run: FlagsRun = {
    input: "flags",
    args,
    deps,
    cwd: deps.cwd ?? process.cwd(),
    processEnv,
    workspaceDir,
    log: deps.log ?? (() => {}),
    // Redact every value from the environment and --env-file that looks secret,
    // even before the plan exists (a bad input message may echo a value).
    secrets: secretValues(processEnv),
    report: emptyInitReport(workspaceDir),
    writes: [],
    outcome: emptyOutcome(),
  };
  try {
    if (await runWorkerInitSteps(run)) finishReport(run);
    return redactReport(run.report, run.secrets);
  } catch (error) {
    // `--json` consumers need a document even when something unexpected throws.
    return redactReport(
      { ...run.report, result: "failure", code: "unexpected_error", error: errorMessage(error) },
      run.secrets,
    );
  }
}

/**
 * Checks that judge what this command writes (credentials, query, repository,
 * the config itself). When one fails, the run restores the files it wrote.
 */
const INPUT_CHECKS = new Set([
  "tracker-auth",
  "credentials",
  "query",
  "repo",
  "workspace-config",
  "work-sources",
]);

/** After every step ran: rollback, next steps, the `--env-file`, and the result. */
function finishReport(run: FlagsRun): void {
  const { args, report, workspaceDir } = run;
  const plan = run.plan!;
  const result = resultFor(report.checks);
  // Input the tracker or code host rejected is never kept: fix it and re-run
  // the same command. A host problem (agent CLI, sandbox, license) keeps the
  // configuration, so `worker doctor` confirms the fix.
  report.persisted = true;
  if (report.checks.some((check) => check.status === "fail" && INPUT_CHECKS.has(check.name))) {
    restoreWrites(run);
  }

  report.nextSteps = nextStepsFor({
    args,
    cwd: run.cwd,
    workspaceDir,
    // `--repo-from-cwd` (a failed run's re-run command keeps it), or a repository already there.
    hasRepo: args.repoFromCwd || (run.draft?.existing?.repos.length ?? 0) > 0,
    persisted: report.persisted,
    signIn: report.signIn,
    checks: report.checks,
    relayConnected: run.outcome.relayConnected,
    env: {
      ...run.processEnv,
      ...parseEnvFile(workspaceEnvPath(workspaceDir)),
      ...plan.credentialEnv,
    },
    envFilePath: plan.envFilePath,
    home: run.deps.home,
    which: run.deps.which,
  });
  handleEnvFile(args, plan, report, result, workspaceDir, run.log);
  report.result = result === "success" && !report.changed ? "unchanged" : result;
  const code = failureCodeFor(report.checks);
  if (code) report.code = code;
}

/** Put back what a failed run wrote, and say so. */
function restoreWrites(run: FlagsRun): void {
  const { report, writes } = run;
  if (writes.length === 0) return;
  const problems = rollbackWrites(run.workspaceDir, writes);
  report.filesWritten = [];
  report.changed = false;
  report.persisted = problems.length > 0;
  report.warnings.push(
    problems.length === 0
      ? "Nothing was saved: the tracker or repository checks failed, so the files this run wrote were restored."
      : `The checks failed, but some files could not be restored: ${problems.join("; ")}`,
  );
  for (const write of writes) run.log(`↩️  Restored ${write.path}`);
}

/** A report check as a readiness row, for the shared next-step builder. */
function asReadinessCheck(check: InitCheck): ReadinessCheck {
  return {
    id: check.name,
    label: check.label,
    status:
      check.status === "pass" || check.status === "skipped"
        ? "ok"
        : check.status === "warn" || check.status === "action"
          ? check.status
          : "fail",
    detail: check.message,
    ...(check.hint ? { hint: check.hint } : {}),
  };
}

function nextStepsFor(options: {
  args: NonInteractiveInitArgs;
  cwd: string;
  workspaceDir: string;
  hasRepo: boolean;
  signIn?: PendingSignIn;
  /** False when a failed check made the run restore what it wrote: fixes re-run setup. */
  persisted: boolean;
  /** The report's checks: a failed check withholds `service` and `connect`. */
  checks: readonly InitCheck[];
  /** The relay step found a pairing: no `connect` step. */
  relayConnected: boolean;
  /** Env the harness check resolved `AGENT_HARNESS` from. */
  env: Env;
  envFilePath?: string;
  home?: string;
  which?: (command: string) => string | null;
}): InitNextStep[] {
  const { args, workspaceDir, home } = options;
  const ctx = { cwd: options.cwd, workspaceDir, envFilePath: options.envFilePath, home };
  const failed = options.checks.some((check) => check.status === "fail");
  const rerun = initRerunCommand(args, ctx);
  const steps: InitNextStep[] = [];
  if (options.signIn) {
    steps.push({
      id: "complete-sign-in",
      message:
        "A person opens the sign-in url in any browser and signs in. The browser then lands on a " +
        "127.0.0.1 page that does not load: pass that page's full address to this command on this host",
      command: options.signIn.complete,
      ...(options.signIn.url ? { url: options.signIn.url } : {}),
    });
  }
  const blockers = options.checks
    .filter((check) => check.status === "fail" || check.status === "action")
    .filter(
      (check) => !(options.signIn && check.name === "entitlement" && check.status === "action"),
    )
    .map(asReadinessCheck);
  steps.push(
    ...blockerNextSteps(blockers, {
      workspaceDir,
      env: options.env,
      home,
      which: options.which,
      fixes: {
        credentials: initRerunCommand(args, ctx, {
          envFile: options.envFilePath ?? "<path>",
        }),
        query: initRerunCommand(args, ctx, { taskQuery: "<query>" }),
        // Nothing was saved: re-run setup, not doctor.
        ...(options.persisted ? {} : { recheck: rerun }),
      },
    }),
  );
  if (!options.hasRepo) {
    steps.push({
      id: "add-repo",
      message: "Register a repository: run this inside its checkout",
      command: `${workspaceEnvPrefixFor(workspaceDir, home)}devintern worker init --non-interactive --yes --repo-from-cwd --json`,
    });
  }
  if (failed) {
    const mentioned = steps.some((step) => step.command === rerun || step.message.includes(rerun));
    if (!options.persisted && !mentioned) {
      steps.push({
        id: "retry",
        message: "Nothing was saved. After the fixes above, re-run setup",
        command: rerun,
      });
    }
    return steps;
  }
  steps.push(serviceStep(workspaceDir, home));
  if (!options.relayConnected) steps.push(connectStep(workspaceDir, home));
  return steps;
}

/**
 * The `--env-file` is the user's file: say it can go once its values are
 * saved, or delete it when `--remove-env-file` asked for that. Never deleted
 * after a failure, and never touched when nothing was saved or when it is the
 * workspace `.env` itself.
 */
function handleEnvFile(
  args: NonInteractiveInitArgs,
  plan: Plan,
  report: NonInteractiveInitReport,
  result: ReadinessResult,
  workspaceDir: string,
  log: (message: string) => void,
): void {
  const path = plan.envFilePath;
  const workspaceEnv = workspaceEnvPath(workspaceDir);
  if (!path || !report.persisted || resolve(path) === resolve(workspaceEnv)) return;
  if (args.removeEnvFile && result !== "failure") {
    try {
      rmSync(path, { force: true });
      report.envFileRemoved = true;
      log(`🗑️  Removed ${path} (--remove-env-file); the values are saved in ${workspaceEnv}`);
    } catch (error) {
      report.warnings.push(`Could not remove ${path}: ${errorMessage(error)}`);
    }
    return;
  }
  report.warnings.push(
    `${path} still holds the credentials; they are saved in ${workspaceEnv} now. Delete it when ` +
      `you no longer need it (rm ${shellQuote(path)}), or pass --remove-env-file next time.`,
  );
}
