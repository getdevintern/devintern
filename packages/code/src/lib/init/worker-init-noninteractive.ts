/**
 * `devintern worker init --non-interactive`: flag-driven worker setup for
 * coding agents, provisioning scripts, and SSH sessions without a TTY.
 *
 * Covers the parts of the wizard that need no human: tracker selection,
 * `[defaults].task_query`, registering the current repository, and saving
 * tracker credentials (from the environment or a 0600 `--env-file`) to the
 * workspace `.env`. It then probes the credentials and runs the same checks
 * as `devintern worker doctor`. Sign-in, relay pairing, and the background
 * service are reported as next steps and never started here.
 *
 * Phases:
 * 1. Validate every input without touching the filesystem.
 * 2. Under an exclusive workspace lock, write `workspace.toml` and `.env`
 *    atomically (temp file + rename), so a concurrent run fails cleanly and
 *    the config is never left half-written.
 * 3. Run the checks and build one report (human text or a versioned JSON
 *    document). Secret values are redacted from every string in the report.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import { defaultProbe } from "@devintern/task-trackers";

import type { ResolvedLogin, StartedPendingLogin } from "@devintern/auth";

import { pendingSignInSummary } from "../account/cli";
import { parseSignInMethod } from "../account/login-args";
import { signInCommand, workerLoginCommandFor } from "../account/worker-pilot";
import {
  failureCodeFor,
  readinessExitCode,
  resultFor,
  toReportCheck,
} from "../observability/readiness-json";
import { collectWorkerDoctorChecks } from "../observability/worker-readiness";
import type { WorkerDoctorDeps, WorkerEntitlementLike } from "../observability/worker-readiness";
import { TRACKER_CAPABILITIES } from "../trackers/capabilities";
import { trackerRequiredEnv } from "../trackers/manager";
import { parseWorkspaceConfig } from "../workspace/config";
import { parseEnvFile } from "../workspace/env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import { errorMessage } from "./worker-init-fs";
import {
  applyPlan,
  planChangesNothing,
  planInit,
  renderPlannedConfig,
  rollbackWrites,
} from "./worker-init-noninteractive-plan";
import type { AppliedWrite, Plan, PlanFailure } from "./worker-init-noninteractive-plan";
import { handleEnvFile, initRerunCommand, nextStepsFor } from "./worker-init-noninteractive-steps";
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

export { readEnvFile, wrongQueryLanguage } from "./worker-init-noninteractive-plan";
export { initRerunCommand } from "./worker-init-noninteractive-steps";
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

/** Per-probe timeout; keeps the whole command bounded when a service hangs. */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

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

/** Reject after `ms` so one hung API call cannot stall the command. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Env keys whose values are secrets and must never be printed. */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSPHRASE|_PAT$|API_KEY|PRIVATE_KEY|LICENSE_KEY/;

/** Replace every secret value from `env` that occurs in `text`. */
export function redactSecrets(text: string, secrets: string[]): string {
  let next = text;
  for (const secret of secrets) {
    if (secret.length >= 4) next = next.split(secret).join("***");
  }
  return next;
}

/**
 * Values of the env keys that name a secret. Only {@link SECRET_KEY} matches
 * count: non-secret settings such as `TASK_TRACKER=jira` or `JIRA_EMAIL` would
 * otherwise mask every occurrence of their value in the report.
 */
function secretValues(env: Env): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value && SECRET_KEY.test(key)) values.add(value);
  }
  // Longest first, so a secret containing another is redacted whole.
  return [...values].sort((a, b) => b.length - a.length);
}

function trackerDisplayName(tracker: string): string {
  return TRACKER_CAPABILITIES[tracker]?.displayName ?? tracker;
}

/** HTTP status named in a tracker error, for the credential-probe message. */
function httpStatusOf(message: string): string | undefined {
  return /\b(401|403)\b/.exec(message)?.[1];
}

/** Probe the tracker credentials the way the wizard does. */
async function credentialCheck(
  plan: Plan,
  probe: NonNullable<NonInteractiveInitDeps["probe"]>,
  timeoutMs: number,
): Promise<InitCheck> {
  const name = trackerDisplayName(plan.tracker);
  const keys = trackerRequiredEnv(plan.tracker);
  const base = { name: "tracker-auth", label: "Tracker credential probe" } as const;
  if (plan.tracker === "markdown") {
    return { ...base, status: "skipped", message: "markdown tracker: no credentials to check" };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(plan.credentialEnv)) if (value) env[key] = value;
  try {
    await withTimeout(probe(plan.tracker, env), timeoutMs, `${name} credential check`);
    // Only name variables the probe actually exercised: without GITHUB_REPO
    // the GitHub check covers the token alone.
    const verified = keys.filter((key) => env[key] || key !== "GITHUB_REPO");
    return { ...base, status: "pass", message: `${name} accepted ${verified.join(", ")}` };
  } catch (error) {
    const message = errorMessage(error);
    const status = httpStatusOf(message);
    return {
      ...base,
      status: "fail",
      message: status
        ? `${name} rejected the credentials (HTTP ${status}): ${message}`
        : `${name} credential check failed: ${message}`,
      hint: `Check ${keys.join(", ")} in the environment or --env-file`,
    };
  }
}

/** Phase 3: credential probe plus every `worker doctor` check. */
async function runChecks(
  plan: Plan,
  workspaceDir: string,
  deps: NonInteractiveInitDeps,
): Promise<{ checks: InitCheck[]; entitled: boolean; signInRequired: boolean }> {
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const auth = await credentialCheck(plan, deps.probe ?? defaultProbe, timeoutMs);
  const authFailed = auth.status === "fail";
  // The credential probe above already ran; do not repeat it inside doctor.
  const doctorDeps: WorkerDoctorDeps = { probeCredentials: async () => {}, ...deps.doctor };
  let entitlement: WorkerEntitlementLike | undefined;
  const checkEntitlement = doctorDeps.checkEntitlement;
  doctorDeps.checkEntitlement = async (dir) => {
    // `worker doctor` loads the workspace .env into process.env first; this
    // command does not, so pass the composed env (workspace .env < env <
    // --env-file): LICENSE_KEY and DEVINTERN_SKIP_LICENSE_CHECK then give the
    // same verdict as `worker doctor`.
    const run = checkEntitlement
      ? checkEntitlement(dir)
      : defaultEntitlement(dir, plan.credentialEnv, deps.checkLicense);
    entitlement = await withTimeout(run, timeoutMs, "license check");
    return entitlement;
  };
  if (authFailed) {
    // The query cannot pass with rejected credentials; skip the API call.
    doctorDeps.dryRunQuery = () => Promise.reject(new Error("skipped"));
  }
  const readiness = await collectWorkerDoctorChecks(
    { workspacePath: workspaceConfigPath(workspaceDir) },
    { processEnv: deps.processEnv ?? process.env, probeTimeoutMs: timeoutMs, ...doctorDeps },
  );

  const checks: InitCheck[] = [auth];
  for (const check of readiness) {
    const mapped = toReportCheck(check);
    if (check.id === "query" && authFailed) {
      checks.push({
        ...mapped,
        status: "skipped",
        message: "not run: the tracker rejected the credentials",
        hint: undefined,
      });
      continue;
    }
    // The entitlement row has the same verdict as `worker doctor`: `action`
    // when nobody is signed in yet, `fail` for anything else.
    checks.push(mapped);
  }
  return {
    checks,
    entitled: entitlement?.valid === true,
    signInRequired: entitlement?.valid !== true && entitlement?.signInRequired === true,
  };
}

async function defaultEntitlement(
  workspaceDir: string,
  env: Env,
  checkLicenseOverride?: NonInteractiveInitDeps["checkLicense"],
): Promise<WorkerEntitlementLike> {
  const [{ checkLicense }, { loadSupabaseConfig }, { workspaceCodeStateDir }] = await Promise.all([
    import("@devintern/license-check"),
    import("../cli/bootstrap"),
    import("../workspace/paths"),
  ]);
  return (checkLicenseOverride ?? checkLicense)({
    productKey: "devintern/code",
    licenseKey: env.LICENSE_KEY || undefined,
    supabaseConfig: loadSupabaseConfig(workspaceCodeStateDir(workspaceDir)),
    requireAutomation: true,
    allowTrial: true,
    setup: true,
    loginCommand: "devintern worker login",
    env,
  });
}

export { resultFor };

/** Start a `--no-wait` sign-in for the workspace session. */
async function defaultStartSignIn(
  workspaceDir: string,
  login: ResolvedLogin,
): Promise<StartedPendingLogin> {
  const [{ startPendingLogin }, { loadSupabaseConfig }, { workspaceCodeStateDir }] =
    await Promise.all([
      import("@devintern/auth"),
      import("../cli/bootstrap"),
      import("../workspace/paths"),
    ]);
  return startPendingLogin(loadSupabaseConfig(workspaceCodeStateDir(workspaceDir)), login);
}

function emptyReport(workspaceDir: string): NonInteractiveInitReport {
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
    { ...emptyReport(workspaceDir), code: "unexpected_error", error: errorMessage(error) },
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
  const ctx: RunContext = {
    args,
    deps,
    cwd: deps.cwd ?? process.cwd(),
    processEnv: deps.processEnv ?? process.env,
    workspaceDir: deps.workspaceDir ?? resolveWorkspaceDir(),
    log: deps.log ?? (() => {}),
    // Redact every value from the environment and --env-file that looks secret,
    // even before the plan exists (a bad input message may echo a value).
    secrets: secretValues(deps.processEnv ?? process.env),
  };
  const report = emptyReport(ctx.workspaceDir);
  try {
    return redactReport(await runInit(ctx, report), ctx.secrets);
  } catch (error) {
    // `--json` consumers need a document even when something unexpected throws.
    return redactReport(
      { ...report, result: "failure", code: "unexpected_error", error: errorMessage(error) },
      ctx.secrets,
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

/** Everything one run shares between its phases. */
interface RunContext {
  args: NonInteractiveInitArgs;
  deps: NonInteractiveInitDeps;
  cwd: string;
  processEnv: Env;
  workspaceDir: string;
  log: (message: string) => void;
  /** Secret values to redact from the report; grows once the plan has the credentials. */
  secrets: string[];
}

function rerunContext(ctx: RunContext, envFilePath?: string) {
  return { cwd: ctx.cwd, workspaceDir: ctx.workspaceDir, envFilePath, home: ctx.deps.home };
}

/** The three phases; the caller redacts the report. */
async function runInit(
  ctx: RunContext,
  report: NonInteractiveInitReport,
): Promise<NonInteractiveInitReport> {
  const { args, workspaceDir, log } = ctx;
  const planned = await planInit(args, ctx);
  if (!planned.ok) return planFailureReport(ctx, report, planned);
  const { plan } = planned;
  ctx.secrets = secretValues(plan.credentialEnv);
  report.tracker = plan.tracker;
  report.taskQuery = plan.taskQuery;
  for (const note of plan.notes) log(note);

  const unchanged = planChangesNothing(plan, workspaceDir);
  if (plan.configSnapshot !== null && !args.yes && !unchanged) {
    return {
      ...report,
      code: "workspace_exists",
      error:
        `${workspaceConfigPath(workspaceDir)} already exists with other settings; nothing was ` +
        "changed. Pass --yes to update its tracker, task_query, and repository entries (all " +
        "other settings are kept).",
      nextSteps: [
        {
          id: "update",
          message: "Update the existing workspace with these flags (other settings are kept)",
          command: initRerunCommand(args, rerunContext(ctx, plan.envFilePath)),
        },
      ],
    };
  }

  let writes: AppliedWrite[] = [];
  if (unchanged) {
    report.repo = renderPlannedConfig(plan, plan.configSnapshot).repo;
    log("ℹ️  The workspace already has this setup; nothing to write.");
  } else {
    const applied = applyPlan(plan, workspaceDir);
    if (!applied.ok) return { ...report, error: applied.error, code: applied.code };
    writes = applied.writes;
    report.filesWritten = applied.filesWritten;
    report.repo = applied.repo;
    for (const file of applied.filesWritten) log(`💾 Wrote ${file}`);
    if (applied.seededProject) log(`   Seeded routing rule: project = ${applied.seededProject}`);
  }
  report.changed = writes.length > 0;
  noteRepo(report, log);

  log("🩺 Running checks...");
  const outcome = await runChecks(plan, workspaceDir, ctx.deps);
  report.checks = outcome.checks;
  await startSignInIfNeeded(ctx, report, outcome);
  const result = resultFor(report.checks);
  // Input the tracker or code host rejected is never kept: fix it and re-run
  // the same command. A host problem (agent CLI, sandbox, license) keeps the
  // configuration, so `worker doctor` confirms the fix.
  report.persisted = true;
  if (report.checks.some((check) => check.status === "fail" && INPUT_CHECKS.has(check.name))) {
    restoreWrites(ctx, report, writes);
  }

  report.nextSteps = nextStepsFor({
    args,
    cwd: ctx.cwd,
    workspaceDir,
    hasRepo: workspaceHasRepo(args, workspaceDir),
    persisted: report.persisted,
    signIn: report.signIn,
    checks: report.checks,
    env: {
      ...ctx.processEnv,
      ...parseEnvFile(workspaceEnvPath(workspaceDir)),
      ...plan.credentialEnv,
    },
    envFilePath: plan.envFilePath,
    home: ctx.deps.home,
    which: ctx.deps.which,
  });
  handleEnvFile(args, plan, report, result, workspaceDir, log);
  report.result = result === "success" && !report.changed ? "unchanged" : result;
  const code = failureCodeFor(report.checks);
  if (code) report.code = code;
  return report;
}

/** The report for input that failed validation; a wrong-language query gets its fix. */
function planFailureReport(
  ctx: RunContext,
  report: NonInteractiveInitReport,
  planned: PlanFailure,
): NonInteractiveInitReport {
  const envFilePath = ctx.args.envFile ? resolve(ctx.cwd, ctx.args.envFile) : undefined;
  const nextSteps: InitNextStep[] =
    planned.code === "invalid_query"
      ? [
          {
            id: "fix-query",
            message: "Re-run setup with a query in the tracker's own search syntax",
            command: initRerunCommand(ctx.args, rerunContext(ctx, envFilePath), {
              taskQuery: "<query>",
            }),
          },
        ]
      : [];
  return {
    ...report,
    tracker: planned.tracker ?? null,
    error: planned.error,
    code: planned.code,
    ...(planned.missing ? { missing: planned.missing } : {}),
    nextSteps,
  };
}

/** Log the repository entry, and warn when the checkout's branch is not the one PRs target. */
function noteRepo(report: NonInteractiveInitReport, log: (message: string) => void): void {
  const repo = report.repo;
  if (!repo) return;
  log(
    repo.added
      ? `✅ Registered ${repo.remote} as "${repo.name}"`
      : `ℹ️  ${repo.remote} is already registered as "${repo.name}"`,
  );
  const { branch, defaultBranch } = repo;
  if (repo.added && branch && defaultBranch && branch !== defaultBranch) {
    report.warnings.push(
      `The checkout is on ${branch}, but tasks start from and pull requests target ` +
        `${defaultBranch} (recorded as default_branch). To open pull requests against ` +
        `${branch} instead, add "--pr-target-branch ${branch}" to [defaults].worker_task_args ` +
        "in workspace.toml.",
    );
  }
}

/** `--sign-in`: start the sign-in when it is the step that is missing. */
async function startSignInIfNeeded(
  ctx: RunContext,
  report: NonInteractiveInitReport,
  outcome: { entitled: boolean; signInRequired: boolean },
): Promise<void> {
  const { args, deps, workspaceDir } = ctx;
  if (!args.signIn) return;
  if (!outcome.signInRequired) {
    ctx.log(
      outcome.entitled
        ? "ℹ️  --sign-in: not needed, this workspace already has an entitlement."
        : "ℹ️  --sign-in: not started; signing in would not fix the entitlement check above.",
    );
    return;
  }
  const loginCommand = workerLoginCommandFor(workspaceConfigPath(workspaceDir), deps.home);
  try {
    const started = await (deps.startSignIn ?? defaultStartSignIn)(workspaceDir, args.signIn);
    report.signIn = pendingSignInSummary(started, loginCommand);
  } catch (error) {
    report.checks.push({
      name: "sign-in",
      label: "Sign-in",
      status: "fail",
      message: `Could not start the sign-in: ${errorMessage(error)}`,
      hint: `Retry with \`${signInCommand(loginCommand)} --no-wait --json\``,
    });
  }
}

/** Put back what a failed run wrote, and say so. */
function restoreWrites(
  ctx: RunContext,
  report: NonInteractiveInitReport,
  writes: AppliedWrite[],
): void {
  if (writes.length === 0) return;
  const problems = rollbackWrites(ctx.workspaceDir, writes);
  report.filesWritten = [];
  report.changed = false;
  report.persisted = problems.length > 0;
  report.warnings.push(
    problems.length === 0
      ? "Nothing was saved: the tracker or repository checks failed, so the files this run wrote were restored."
      : `The checks failed, but some files could not be restored: ${problems.join("; ")}`,
  );
  for (const write of writes) ctx.log(`↩️  Restored ${write.path}`);
}

/**
 * Whether the add-repo step can be left out: `--repo-from-cwd` was given (a
 * failed run's re-run command keeps it), or the workspace has a repository.
 */
function workspaceHasRepo(args: NonInteractiveInitArgs, workspaceDir: string): boolean {
  if (args.repoFromCwd) return true;
  try {
    return (
      parseWorkspaceConfig(readFileSync(workspaceConfigPath(workspaceDir), "utf8")).repos.length > 0
    );
  } catch {
    // The config check already reports an unreadable workspace.
    return false;
  }
}
