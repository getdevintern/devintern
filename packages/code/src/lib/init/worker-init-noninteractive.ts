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

import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";

import { defaultProbe } from "@devintern/task-trackers";
import { upsertEnvVars } from "@devintern/utils";

import type { ResolvedLogin, StartedPendingLogin } from "@devintern/auth";

import { pendingSignInSummary } from "../account/cli";
import type { PendingSignIn } from "../account/cli";
import { parseSignInMethod } from "../account/login-args";
import {
  WORKER_PILOT_NOT_STARTED,
  signInCommand,
  workerLoginCommandFor,
} from "../account/worker-pilot";
import { redactUrlCredentials } from "../observability/dashboard-workspace";
import { collectWorkerDoctorChecks } from "../observability/worker-readiness";
import type { LicenseCheckOptions } from "@devintern/license-check";
import type { WorkerDoctorDeps, WorkerEntitlementLike } from "../observability/worker-readiness";
import type { ReadinessCheck } from "../observability/readiness";
import { hasGitHubRelayRegistration, loadRelayState } from "../relay/connect";
import { TRACKER_CAPABILITIES, trackersSupportingPolling } from "../trackers/capabilities";
import { trackerRequiredEnv } from "../trackers/manager";
import { Utils } from "../utils";
import { gitHubSlugFromRemote, parseWorkspaceConfig } from "../workspace/config";
import { parseEnvFile, parseEnvFileContent } from "../workspace/env";
import {
  CONFIG_TEMPLATE,
  ENV_TEMPLATE,
  appendRepoEntry,
  readRepoEnv,
  repoDefaultProjectKey,
  splitRepoEnv,
  upsertWorkspaceDefaults,
} from "../workspace/init";
import {
  ensureWorkspaceCodeState,
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceEnvPath,
} from "../workspace/paths";
import { TRACKER_SETUP } from "./scaffold";
import {
  acquireWorkspaceInitLock,
  condenseMessage,
  errorMessage,
  writeFileAtomic,
} from "./worker-init-fs";

export {
  WORKER_INIT_LOCK_FILE,
  acquireWorkspaceInitLock,
  condenseMessage,
  removeStaleLock,
} from "./worker-init-fs";

/** `schema` value of the `--json` document. Bump `version` on breaking changes. */
export const WORKER_INIT_JSON_SCHEMA = "devintern.worker-init";
/** Current `--json` document version. */
export const WORKER_INIT_JSON_VERSION = 1;

/** Per-probe timeout; keeps the whole command bounded when a service hangs. */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

type Env = Record<string, string | undefined>;

/** Parsed `worker init --non-interactive` flags. */
export interface NonInteractiveInitArgs {
  tracker?: string;
  taskQuery?: string;
  repoFromCwd: boolean;
  envFile?: string;
  json: boolean;
  yes: boolean;
  /** `--sign-in <method>`: start a `--no-wait` sign-in when one is needed. */
  signIn?: ResolvedLogin;
}

/** `action`: nothing is broken, one step for the user is left (signing in). */
export type CheckStatus = "pass" | "warn" | "action" | "fail" | "skipped";

/**
 * `action_required`: every check passed or warned except a step for the user
 * (signing in to start the Worker Pilot). Exit code 2.
 */
export type InitResult = "success" | "action_required" | "failure";

/** One check in the report. */
export interface InitCheck {
  /** Stable check name (e.g. `tracker-auth`, `query`, `repo`). */
  name: string;
  label: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

/** One remaining step the user (or agent) still has to do. */
export interface InitNextStep {
  id: "sign-in" | "connect" | "add-repo" | "start" | "service";
  message: string;
  command: string;
}

/** The report printed by the command; `--json` prints it verbatim. */
export interface NonInteractiveInitReport {
  schema: typeof WORKER_INIT_JSON_SCHEMA;
  version: typeof WORKER_INIT_JSON_VERSION;
  result: InitResult;
  /** Set when the command stopped before running checks (bad input, busy workspace). */
  error?: string;
  workspaceDir: string;
  tracker: string | null;
  taskQuery: string | null;
  repo: { name: string; remote: string; added: boolean } | null;
  filesWritten: string[];
  checks: InitCheck[];
  nextSteps: InitNextStep[];
  /** Set when `--sign-in` started a sign-in: open `url`, then run `complete` on this host. */
  signIn?: PendingSignIn;
}

/** Exit code for a report: 0 success, 2 action required, 1 failure. */
export function initExitCode(result: InitResult): number {
  return result === "success" ? 0 : result === "action_required" ? 2 : 1;
}

export interface NonInteractiveInitDeps {
  /** Working directory for `--repo-from-cwd` and relative `--env-file`. */
  cwd?: string;
  /** Process environment; defaults to `process.env`. */
  processEnv?: Env;
  /** Workspace home; defaults to `resolveWorkspaceDir()`. */
  workspaceDir?: string;
  /** Tracker credential probe; defaults to the wizard's probe. */
  probe?: (trackerId: string, env: Record<string, string>) => Promise<void>;
  /** Overrides for the `worker doctor` checks (tests). */
  doctor?: WorkerDoctorDeps;
  /** License validator behind the default entitlement check; defaults to `checkLicense` (tests). */
  checkLicense?: (options: LicenseCheckOptions) => Promise<WorkerEntitlementLike>;
  /** Per-probe timeout. */
  probeTimeoutMs?: number;
  /** Progress messages (human mode only). */
  log?: (message: string) => void;
  /** Starts a `--no-wait` sign-in for the workspace (tests); defaults to `startPendingLogin`. */
  startSignIn?: (workspaceDir: string, login: ResolvedLogin) => Promise<StartedPendingLogin>;
  /** Home directory used to decide whether commands need `--workspace` (tests). */
  home?: string;
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

/** Read the `--env-file`, refusing files readable by group or others. */
export function readEnvFile(
  path: string,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    return { ok: false, error: `Cannot read --env-file ${path}: ${errorMessage(error)}` };
  }
  if ((mode & 0o077) !== 0) {
    return {
      ok: false,
      error:
        `Refusing to read --env-file ${path}: mode ${(mode & 0o777).toString(8).padStart(4, "0")} ` +
        `lets group or others read it. Fix: chmod 600 ${path}`,
    };
  }
  try {
    return { ok: true, values: parseEnvFileContent(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: `Cannot read --env-file ${path}: ${errorMessage(error)}` };
  }
}

/**
 * Resolve the current checkout's `origin` for `--repo-from-cwd`. Any remote is
 * accepted (as in `worker add-repo`); `slug` is set only for GitHub remotes and
 * is used solely to default `GITHUB_REPO` for the github tracker.
 */
async function detectCwdRepo(
  cwd: string,
): Promise<
  { ok: true; root: string; remote: string; slug: string | null } | { ok: false; error: string }
> {
  const top = await Utils.executeGitCommand(["rev-parse", "--show-toplevel"], { cwd });
  if (!top.success || !top.output.trim()) {
    return { ok: false, error: `--repo-from-cwd: ${cwd} is not inside a git repository.` };
  }
  const root = top.output.trim();
  const remoteResult = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
    cwd: root,
  });
  const remote = remoteResult.success ? remoteResult.output.trim() : "";
  if (!remote) {
    return {
      ok: false,
      error: `--repo-from-cwd: ${root} has no origin remote. Add one with \`git remote add origin <url>\`.`,
    };
  }
  return { ok: true, root, remote, slug: gitHubSlugFromRemote(remote) };
}

function trackerDisplayName(tracker: string): string {
  return TRACKER_CAPABILITIES[tracker]?.displayName ?? tracker;
}

/** Validated inputs and the writes they imply. */
interface Plan {
  tracker: string;
  taskQuery: string;
  /** Flags named on the command line (only these are updated in an existing workspace). */
  setTracker: boolean;
  setTaskQuery: boolean;
  /**
   * `slug` is the GitHub `owner/name`, or null for a non-GitHub remote.
   * `conflicts`/`projectKey` come from the checkout's `.devintern-code/.env`,
   * exactly as `worker add-repo` uses them.
   */
  repo?: {
    remote: string;
    slug: string | null;
    root: string;
    conflicts: Record<string, string>;
    projectKey?: string;
  };
  /** Composed credentials: workspace `.env` < process env < `--env-file`. */
  credentialEnv: Env;
  /** Keys to save to the workspace `.env`. */
  envUpdates: Record<string, string>;
  /** One-line notes for the text output (for example a path made absolute). */
  notes: string[];
  /** Snapshot of workspace.toml when validated (null when absent). */
  configSnapshot: string | null;
}

/** Snapshot and parse an existing workspace.toml; refuses without `--yes`. */
function readExistingWorkspace(
  workspaceDir: string,
  yes: boolean,
):
  | {
      ok: true;
      configSnapshot: string | null;
      existing?: ReturnType<typeof parseWorkspaceConfig>;
    }
  | { ok: false; error: string } {
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) return { ok: true, configSnapshot: null };
  if (!yes) {
    return {
      ok: false,
      error:
        `${configPath} already exists; nothing was changed. Pass --yes to update its tracker, ` +
        "task_query, and repository entries (all other settings are kept).",
    };
  }
  let configSnapshot: string;
  try {
    configSnapshot = readFileSync(configPath, "utf8");
  } catch (error) {
    return { ok: false, error: `Cannot read ${configPath}: ${errorMessage(error)}` };
  }
  try {
    return { ok: true, configSnapshot, existing: parseWorkspaceConfig(configSnapshot, configPath) };
  } catch (error) {
    return { ok: false, error: `Cannot update ${configPath}: ${errorMessage(error)}` };
  }
}

/** Every missing flag and tracker variable, in one list. */
function missingInputs(
  tracker: string | undefined,
  taskQuery: string | undefined,
  credentialEnv: Env,
): string[] {
  const missing: string[] = [];
  if (!tracker) missing.push("--tracker");
  if (!taskQuery) missing.push("--task-query");
  if (tracker) {
    for (const key of trackerRequiredEnv(tracker)) if (!credentialEnv[key]) missing.push(key);
  }
  return missing;
}

/**
 * Values to save to the workspace `.env`: every `--env-file` value, plus this
 * tracker's settings and the PR token from the environment, so the service
 * and `worker doctor` see them later. Unchanged values are left alone.
 */
function computeEnvUpdates(
  tracker: string,
  credentialEnv: Env,
  workspaceEnv: Record<string, string>,
  envFileValues: Record<string, string>,
): Record<string, string> {
  const trackerKeys = new Set([
    ...trackerRequiredEnv(tracker),
    ...(TRACKER_SETUP[tracker] ?? []).map((step) => step.key),
    "GITHUB_TOKEN",
  ]);
  const envUpdates: Record<string, string> = {};
  for (const key of trackerKeys) {
    const value = credentialEnv[key];
    if (value && workspaceEnv[key] !== value) envUpdates[key] = value;
  }
  for (const [key, value] of Object.entries(envFileValues)) {
    if (workspaceEnv[key] !== value) envUpdates[key] = value;
  }
  if (workspaceEnv.TASK_TRACKER && workspaceEnv.TASK_TRACKER !== tracker) {
    envUpdates.TASK_TRACKER = tracker;
  }
  return envUpdates;
}

/** Phase 1: validate every input. Touches nothing on disk. */
async function planInit(
  args: NonInteractiveInitArgs,
  ctx: { cwd: string; processEnv: Env; workspaceDir: string },
): Promise<{ ok: true; plan: Plan } | { ok: false; error: string; tracker?: string }> {
  const supported = trackersSupportingPolling();
  const flagTracker = args.tracker?.trim().toLowerCase();
  if (flagTracker && !supported.includes(flagTracker)) {
    return {
      ok: false,
      error: `Unsupported --tracker "${args.tracker}". Supported trackers: ${supported.join(", ")}.`,
    };
  }

  let envFileValues: Record<string, string> = {};
  if (args.envFile) {
    const read = readEnvFile(resolve(ctx.cwd, args.envFile));
    if (!read.ok) return read;
    envFileValues = read.values;
  }

  const read = readExistingWorkspace(ctx.workspaceDir, args.yes);
  if (!read.ok) return read;
  const { configSnapshot, existing } = read;

  let repo: Plan["repo"];
  if (args.repoFromCwd) {
    const detected = await detectCwdRepo(ctx.cwd);
    if (!detected.ok) return detected;
    repo = { remote: detected.remote, slug: detected.slug, root: detected.root, conflicts: {} };
  }

  const tracker = flagTracker ?? existing?.defaults.tracker;
  const taskQuery = args.taskQuery?.trim() || existing?.defaults.taskQuery;
  const workspaceEnvFile = workspaceEnvPath(ctx.workspaceDir);
  // Same parser the worker and `worker doctor` use, so all three agree.
  const workspaceEnv = parseEnvFile(workspaceEnvFile);
  const credentialEnv: Env = { ...workspaceEnv, ...ctx.processEnv, ...envFileValues };
  if (tracker === "github" && !credentialEnv.GITHUB_REPO && repo?.slug) {
    credentialEnv.GITHUB_REPO = repo.slug;
  }

  const notes: string[] = [];
  if (tracker === "markdown") {
    // The worker daemon (service cwd: the workspace) and each task run (cwd:
    // the repo checkout) would resolve a relative folder differently, so save
    // the folder the user means: relative to where this command runs.
    const supplied = envFileValues.MARKDOWN_TASKS_DIR || ctx.processEnv.MARKDOWN_TASKS_DIR;
    if (supplied && !isAbsolute(supplied)) {
      const absolute = resolve(ctx.cwd, supplied);
      credentialEnv.MARKDOWN_TASKS_DIR = absolute;
      if (envFileValues.MARKDOWN_TASKS_DIR) {
        envFileValues = { ...envFileValues, MARKDOWN_TASKS_DIR: absolute };
      }
      notes.push(`ℹ️  MARKDOWN_TASKS_DIR=${supplied} saved as the absolute path ${absolute}`);
    }
  }

  const missing = missingInputs(tracker, taskQuery, credentialEnv);
  if (missing.length > 0) {
    const markdownDir =
      tracker === "markdown" && missing.includes("MARKDOWN_TASKS_DIR")
        ? " MARKDOWN_TASKS_DIR is the folder that holds the Markdown task files; set it to an " +
          "absolute path, for example MARKDOWN_TASKS_DIR=$PWD/tasks."
        : "";
    return {
      ok: false,
      tracker,
      error:
        `missing: ${missing.join(", ")}. Pass the flags, and set credentials in the ` +
        `environment or in a file passed with --env-file <path> (mode 0600).${markdownDir}`,
    };
  }

  const envUpdates = computeEnvUpdates(tracker!, credentialEnv, workspaceEnv, envFileValues);
  if (repo) {
    // Same import as `worker add-repo`: the checkout's project env fills keys
    // the workspace `.env` lacks; differing values stay repo-local. Compared
    // after this run's credential updates, which always win.
    const repoEnv = readRepoEnv(ctx.cwd);
    const split = splitRepoEnv(repoEnv, { ...workspaceEnv, ...envUpdates });
    Object.assign(envUpdates, split.additions);
    repo.conflicts = split.conflicts;
    repo.projectKey = repoDefaultProjectKey(repoEnv);
  }

  return {
    ok: true,
    plan: {
      tracker: tracker!,
      taskQuery: taskQuery!,
      setTracker: Boolean(flagTracker) || configSnapshot === null,
      setTaskQuery: Boolean(args.taskQuery?.trim()) || configSnapshot === null,
      repo,
      credentialEnv,
      envUpdates,
      notes,
      configSnapshot,
    },
  };
}

/** Phase 2: write workspace.toml and `.env` under the workspace lock. */
function applyPlan(
  plan: Plan,
  workspaceDir: string,
):
  | {
      ok: true;
      filesWritten: string[];
      repo: NonInteractiveInitReport["repo"];
      seededProject?: string;
    }
  | { ok: false; error: string } {
  try {
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, error: `Cannot create ${workspaceDir}: ${errorMessage(error)}` };
  }
  const lock = acquireWorkspaceInitLock(workspaceDir);
  if (!lock.ok) return lock;
  try {
    const configPath = workspaceConfigPath(workspaceDir);
    const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
    if (current !== plan.configSnapshot) {
      return {
        ok: false,
        error: `The workspace is being modified: ${configPath} changed while this command ran. Re-run it.`,
      };
    }

    let content = upsertWorkspaceDefaults(current ?? CONFIG_TEMPLATE, {
      tracker: plan.setTracker ? plan.tracker : undefined,
      taskQuery: plan.setTaskQuery ? plan.taskQuery : undefined,
    });
    let repo: NonInteractiveInitReport["repo"] = null;
    let seededProject: string | undefined;
    if (plan.repo) {
      const appended = appendRepoEntry(content, plan.repo.remote, {
        conflicts: plan.repo.conflicts,
        projectKey: plan.repo.projectKey,
      });
      content = appended.content;
      seededProject = appended.seededProject;
      repo = {
        name: appended.name,
        remote: redactUrlCredentials(plan.repo.remote),
        added: appended.added,
      };
    }
    try {
      parseWorkspaceConfig(content, configPath);
    } catch (error) {
      return {
        ok: false,
        error: `Refusing to write an invalid ${configPath}: ${errorMessage(error)}`,
      };
    }

    const filesWritten: string[] = [];
    // Credentials first: a config that names a tracker without its
    // credentials is worse than credentials with no config change.
    const envPath = workspaceEnvPath(workspaceDir);
    const envExists = existsSync(envPath);
    if (!envExists || Object.keys(plan.envUpdates).length > 0) {
      const base = envExists ? readFileSync(envPath, "utf8") : ENV_TEMPLATE;
      writeFileAtomic(envPath, upsertEnvVars(base, plan.envUpdates), 0o600);
      filesWritten.push(envPath);
    }
    if (content !== current) {
      writeFileAtomic(configPath, content);
      filesWritten.push(configPath);
    }
    ensureWorkspaceCodeState(workspaceDir);
    return { ok: true, filesWritten, repo, seededProject };
  } catch (error) {
    return { ok: false, error: `Cannot write to ${workspaceDir}: ${errorMessage(error)}` };
  } finally {
    lock.release();
  }
}

function toInitCheck(check: ReadinessCheck): InitCheck {
  const status: CheckStatus =
    check.status === "ok"
      ? "pass"
      : check.status === "warn" || check.status === "action"
        ? check.status
        : "fail";
  return {
    name: check.id,
    label: check.label,
    status,
    message: condenseMessage(check.detail ?? ""),
    ...(check.hint && status !== "pass" ? { hint: check.hint } : {}),
  };
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
  const base = { name: "tracker-auth", label: "Tracker credentials" } as const;
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
    // command does not, so pass the composed key (workspace .env < env < --env-file).
    const run = checkEntitlement
      ? checkEntitlement(dir)
      : defaultEntitlement(dir, plan.credentialEnv.LICENSE_KEY || undefined, deps.checkLicense);
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
    const mapped = toInitCheck(check);
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
  licenseKey: string | undefined,
  checkLicenseOverride?: NonInteractiveInitDeps["checkLicense"],
): Promise<WorkerEntitlementLike> {
  const [{ checkLicense }, { loadSupabaseConfig }, { workspaceCodeStateDir }] = await Promise.all([
    import("@devintern/license-check"),
    import("../cli/bootstrap"),
    import("../workspace/paths"),
  ]);
  return (checkLicenseOverride ?? checkLicense)({
    productKey: "devintern/code",
    licenseKey,
    supabaseConfig: loadSupabaseConfig(workspaceCodeStateDir(workspaceDir)),
    requireAutomation: true,
    allowTrial: true,
    setup: true,
    loginCommand: "devintern worker login",
  });
}

function nextStepsFor(options: {
  workspaceDir: string;
  entitled: boolean;
  hasRepo: boolean;
  loginCommand: string;
  signIn?: PendingSignIn;
}): InitNextStep[] {
  const steps: InitNextStep[] = [];
  if (options.signIn) {
    steps.push({
      id: "sign-in",
      message: `${WORKER_PILOT_NOT_STARTED}. Open signIn.url in a browser, then finish on this host with the address it lands on`,
      command: options.signIn.complete,
    });
  } else if (!options.entitled) {
    steps.push({
      id: "sign-in",
      message:
        `${WORKER_PILOT_NOT_STARTED} (or set LICENSE_KEY). Other methods: google, x, ` +
        "email you@company.com. Without a terminal, re-run with --sign-in <method>",
      command: signInCommand(options.loginCommand),
    });
  }
  if (!options.hasRepo) {
    steps.push({
      id: "add-repo",
      message: "Register a repository (run inside its checkout)",
      command: "devintern worker add-repo",
    });
  }
  let relayConnected = false;
  try {
    relayConnected = hasGitHubRelayRegistration(loadRelayState(options.workspaceDir));
  } catch {
    relayConnected = false;
  }
  if (!relayConnected) {
    steps.push({
      id: "connect",
      message: "Optional: pair the relay for instant events (polling works without it)",
      command: "devintern worker connect",
    });
  }
  steps.push(
    {
      id: "start",
      message: "Start the worker in the foreground",
      command: "devintern worker",
    },
    {
      id: "service",
      message: "Or install it as a background service: run the wizard in a terminal",
      command: "devintern worker init",
    },
  );
  return steps;
}

/** `failure` if any check fails, `action_required` if one needs a user step, else `success`. */
export function resultFor(checks: readonly InitCheck[]): InitResult {
  if (checks.some((check) => check.status === "fail")) return "failure";
  if (checks.some((check) => check.status === "action")) return "action_required";
  return "success";
}

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
    { ...emptyReport(workspaceDir), error: errorMessage(error) },
    secretValues(env),
  );
}

/**
 * Run non-interactive worker setup end to end. Never prompts, opens a
 * browser, installs a service, or starts the worker.
 *
 * @returns The report; `result` is `failure` on bad input or any failed check
 */
export async function runNonInteractiveWorkerInit(
  args: NonInteractiveInitArgs,
  deps: NonInteractiveInitDeps = {},
): Promise<NonInteractiveInitReport> {
  const cwd = deps.cwd ?? process.cwd();
  const processEnv = deps.processEnv ?? process.env;
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();
  const log = deps.log ?? (() => {});
  const report = emptyReport(workspaceDir);
  // Redact every value from the environment and --env-file that looks secret,
  // even before the plan exists (a bad input message may echo a value).
  let secrets = secretValues(processEnv);
  try {
    const planned = await planInit(args, { cwd, processEnv, workspaceDir });
    if (!planned.ok) {
      return redactReport(
        { ...report, tracker: planned.tracker ?? null, error: planned.error },
        secrets,
      );
    }
    const { plan } = planned;
    secrets = secretValues(plan.credentialEnv);
    report.tracker = plan.tracker;
    report.taskQuery = plan.taskQuery;
    for (const note of plan.notes) log(note);

    const applied = applyPlan(plan, workspaceDir);
    if (!applied.ok) return redactReport({ ...report, error: applied.error }, secrets);
    report.filesWritten = applied.filesWritten;
    report.repo = applied.repo;
    for (const file of applied.filesWritten) log(`💾 Wrote ${file}`);
    if (applied.repo) {
      log(
        applied.repo.added
          ? `✅ Registered ${applied.repo.remote} as "${applied.repo.name}"`
          : `ℹ️  ${applied.repo.remote} is already registered as "${applied.repo.name}"`,
      );
    }
    if (applied.seededProject) log(`   Seeded routing rule: project = ${applied.seededProject}`);

    log("🩺 Running checks...");
    const { checks, entitled, signInRequired } = await runChecks(plan, workspaceDir, deps);
    report.checks = checks;
    const loginCommand = workerLoginCommandFor(workspaceConfigPath(workspaceDir), deps.home);
    if (args.signIn && signInRequired) {
      try {
        const started = await (deps.startSignIn ?? defaultStartSignIn)(workspaceDir, args.signIn);
        report.signIn = pendingSignInSummary(started, loginCommand);
      } catch (error) {
        checks.push({
          name: "sign-in",
          label: "Sign-in",
          status: "fail",
          message: `Could not start the sign-in: ${errorMessage(error)}`,
          hint: `Retry with \`${signInCommand(loginCommand)} --no-wait\``,
        });
      }
    } else if (args.signIn) {
      log(
        entitled
          ? "ℹ️  --sign-in: not needed, this workspace already has an entitlement."
          : "ℹ️  --sign-in: not started; signing in would not fix the entitlement check above.",
      );
    }
    let hasRepo = Boolean(applied.repo);
    try {
      hasRepo =
        hasRepo ||
        parseWorkspaceConfig(readFileSync(workspaceConfigPath(workspaceDir), "utf8")).repos.length >
          0;
    } catch {
      // The config check already reports an unreadable workspace.
    }
    report.nextSteps = nextStepsFor({
      workspaceDir,
      entitled,
      hasRepo,
      loginCommand,
      signIn: report.signIn,
    });
    report.result = resultFor(checks);
    return redactReport(report, secrets);
  } catch (error) {
    // `--json` consumers need a document even when something unexpected throws.
    return redactReport({ ...report, result: "failure", error: errorMessage(error) }, secrets);
  }
}
