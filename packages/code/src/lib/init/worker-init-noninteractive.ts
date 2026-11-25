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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";

import { defaultProbe, parseEnvContent } from "@devintern/task-trackers";
import { upsertEnvVars } from "@devintern/utils";

import { redactUrlCredentials } from "../observability/dashboard-workspace";
import { collectWorkerDoctorChecks } from "../observability/worker-readiness";
import type { WorkerDoctorDeps, WorkerEntitlementLike } from "../observability/worker-readiness";
import type { ReadinessCheck } from "../observability/readiness";
import { hasGitHubRelayRegistration, loadRelayState } from "../relay/connect";
import { TRACKER_CAPABILITIES, trackersSupportingPolling } from "../trackers/capabilities";
import { trackerRequiredEnv } from "../trackers/manager";
import { Utils } from "../utils";
import { isProcessAlive } from "../utils/repo-git-lock";
import { gitHubSlugFromRemote, parseWorkspaceConfig } from "../workspace/config";
import {
  CONFIG_TEMPLATE,
  ENV_TEMPLATE,
  appendRepoEntry,
  upsertWorkspaceDefaults,
} from "../workspace/init";
import {
  ensureWorkspaceCodeState,
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceEnvPath,
} from "../workspace/paths";
import { TRACKER_SETUP } from "./scaffold";

/** `schema` value of the `--json` document. Bump `version` on breaking changes. */
export const WORKER_INIT_JSON_SCHEMA = "devintern.worker-init";
/** Current `--json` document version. */
export const WORKER_INIT_JSON_VERSION = 1;

/** Per-probe timeout; keeps the whole command bounded when a service hangs. */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/** Lock file guarding concurrent writes to one workspace. */
export const WORKER_INIT_LOCK_FILE = ".worker-init.lock";

type Env = Record<string, string | undefined>;

/** Parsed `worker init --non-interactive` flags. */
export interface NonInteractiveInitArgs {
  tracker?: string;
  taskQuery?: string;
  repoFromCwd: boolean;
  envFile?: string;
  json: boolean;
  yes: boolean;
}

export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

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
  result: "success" | "failure";
  /** Set when the command stopped before running checks (bad input, busy workspace). */
  error?: string;
  workspaceDir: string;
  tracker: string | null;
  taskQuery: string | null;
  repo: { name: string; remote: string; added: boolean } | null;
  filesWritten: string[];
  checks: InitCheck[];
  nextSteps: InitNextStep[];
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
  /** Per-probe timeout. */
  probeTimeoutMs?: number;
  /** Progress messages (human mode only). */
  log?: (message: string) => void;
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

/** Longest message kept in a check row. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * One bounded line: an HTML error page body (some trackers return one for
 * 404/5xx) is dropped, whitespace collapsed, and the result truncated.
 */
export function condenseMessage(message: string): string {
  const html = message.search(/<(!doctype|html)\b/i);
  const text = (
    html >= 0 ? `${message.slice(0, html).replace(/[\s:-]+$/, "")} (HTML error page)` : message
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

/** Error message without a stack trace, on one bounded line. */
function errorMessage(error: unknown): string {
  return condenseMessage(error instanceof Error ? error.message : String(error));
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

/** Write `content` to `path` via a sibling temp file and rename (atomic on POSIX). */
function writeFileAtomic(path: string, content: string, mode?: number): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content, mode === undefined ? undefined : { mode });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Temp file was never created or is already gone.
    }
    throw error;
  }
}

/**
 * Take the workspace write lock without waiting. A lock left by a dead
 * process is taken over once.
 *
 * @returns A release function, or an error message when another run holds it
 */
export function acquireWorkspaceInitLock(
  workspaceDir: string,
): { ok: true; release: () => void } | { ok: false; error: string } {
  const lockPath = join(workspaceDir, WORKER_INIT_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), {
        flag: "wx",
        mode: 0o600,
      });
      return {
        ok: true,
        release: () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already removed.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, error: `Cannot create ${lockPath}: ${errorMessage(error)}` };
      }
      let holder: number | undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && "pid" in parsed) {
          holder = typeof parsed.pid === "number" ? parsed.pid : undefined;
        }
      } catch {
        holder = undefined;
      }
      if (holder !== undefined && isProcessAlive(holder)) {
        return {
          ok: false,
          error:
            `The workspace is being modified by another \`devintern worker init\` (pid ${holder}). ` +
            `Wait for it to finish, then re-run. Lock: ${lockPath}`,
        };
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Another run removed it first; retry the create.
      }
    }
  }
  return {
    ok: false,
    error: `The workspace is being modified by another process (lock ${lockPath}); re-run.`,
  };
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

function secretValues(env: Env, extraKeys: Iterable<string>): string[] {
  const keys = new Set(extraKeys);
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (SECRET_KEY.test(key) || keys.has(key)) values.add(value);
  }
  // Longest first, so a secret containing another is redacted whole.
  return [...values].sort((a, b) => b.length - a.length);
}

/** Read the `--env-file`, refusing files readable by group or others. */
function readEnvFile(
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
    return { ok: true, values: parseEnvContent(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: `Cannot read --env-file ${path}: ${errorMessage(error)}` };
  }
}

/** Resolve the current checkout's GitHub `origin` for `--repo-from-cwd`. */
async function detectCwdRepo(
  cwd: string,
): Promise<
  { ok: true; root: string; remote: string; slug: string } | { ok: false; error: string }
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
  const slug = gitHubSlugFromRemote(remote);
  if (!slug) {
    return {
      ok: false,
      error: `--repo-from-cwd: the origin remote of ${root} (${redactUrlCredentials(remote)}) is not a GitHub repository.`,
    };
  }
  return { ok: true, root, remote, slug };
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
  repo?: { remote: string; slug: string; root: string };
  /** Composed credentials: workspace `.env` < process env < `--env-file`. */
  credentialEnv: Env;
  /** Keys to save to the workspace `.env`. */
  envUpdates: Record<string, string>;
  /** Snapshot of workspace.toml when validated (null when absent). */
  configSnapshot: string | null;
  secretKeys: Set<string>;
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
  const configSnapshot = readFileSync(configPath, "utf8");
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
    repo = { remote: detected.remote, slug: detected.slug, root: detected.root };
  }

  const tracker = flagTracker ?? existing?.defaults.tracker;
  const taskQuery = args.taskQuery?.trim() || existing?.defaults.taskQuery;
  const workspaceEnvFile = workspaceEnvPath(ctx.workspaceDir);
  const workspaceEnv = existsSync(workspaceEnvFile)
    ? parseEnvContent(readFileSync(workspaceEnvFile, "utf8"))
    : {};
  const credentialEnv: Env = { ...workspaceEnv, ...ctx.processEnv, ...envFileValues };
  if (tracker === "github" && !credentialEnv.GITHUB_REPO && repo) {
    credentialEnv.GITHUB_REPO = repo.slug;
  }

  const missing = missingInputs(tracker, taskQuery, credentialEnv);
  if (missing.length > 0) {
    return {
      ok: false,
      tracker,
      error:
        `missing: ${missing.join(", ")}. Pass the flags, and set credentials in the ` +
        "environment or in a file passed with --env-file <path> (mode 0600).",
    };
  }

  const envUpdates = computeEnvUpdates(tracker!, credentialEnv, workspaceEnv, envFileValues);

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
      configSnapshot,
      secretKeys: new Set(Object.keys(envFileValues)),
    },
  };
}

/** Phase 2: write workspace.toml and `.env` under the workspace lock. */
function applyPlan(
  plan: Plan,
  workspaceDir: string,
):
  | { ok: true; filesWritten: string[]; repo: NonInteractiveInitReport["repo"] }
  | { ok: false; error: string } {
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
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
    if (plan.repo) {
      const appended = appendRepoEntry(content, plan.repo.remote);
      content = appended.content;
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
    return { ok: true, filesWritten, repo };
  } finally {
    lock.release();
  }
}

function toInitCheck(check: ReadinessCheck): InitCheck {
  const status: CheckStatus =
    check.status === "ok" ? "pass" : check.status === "warn" ? "warn" : "fail";
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
    return { ...base, status: "pass", message: `${name} accepted ${keys.join(", ")}` };
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
): Promise<{ checks: InitCheck[]; entitled: boolean }> {
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const auth = await credentialCheck(plan, deps.probe ?? defaultProbe, timeoutMs);
  const authFailed = auth.status === "fail";
  const doctorDeps: WorkerDoctorDeps = { ...deps.doctor };
  let entitlement: WorkerEntitlementLike | undefined;
  const checkEntitlement = doctorDeps.checkEntitlement;
  doctorDeps.checkEntitlement = async (dir) => {
    const run = checkEntitlement ? checkEntitlement(dir) : defaultEntitlement(dir);
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
    if (check.id === "entitlement" && mapped.status === "fail") {
      // Sign-in is a next step, not a failure of the setup this command did.
      checks.push({
        ...mapped,
        status: "warn",
        message: `sign-in needed: ${mapped.message}`,
        hint: "Run `devintern worker login` to start the free Worker Pilot, or set LICENSE_KEY in the workspace .env",
      });
      continue;
    }
    checks.push(mapped);
  }
  return { checks, entitled: entitlement?.valid === true };
}

async function defaultEntitlement(workspaceDir: string): Promise<WorkerEntitlementLike> {
  const [{ checkLicense }, { loadSupabaseConfig }, { workspaceCodeStateDir }] = await Promise.all([
    import("@devintern/license-check"),
    import("../cli/bootstrap"),
    import("../workspace/paths"),
  ]);
  return checkLicense({
    productKey: "devintern/code",
    supabaseConfig: loadSupabaseConfig(workspaceCodeStateDir(workspaceDir)),
    requireAutomation: true,
    allowTrial: true,
  });
}

function nextStepsFor(options: {
  workspaceDir: string;
  entitled: boolean;
  hasRepo: boolean;
}): InitNextStep[] {
  const steps: InitNextStep[] = [];
  if (!options.entitled) {
    steps.push({
      id: "sign-in",
      message: "sign-in needed: sign in to start the free Worker Pilot (or set LICENSE_KEY)",
      command: "devintern worker login",
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

/** Redact secrets from every string in the report. */
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
  return redact(report) as NonInteractiveInitReport;
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
  let secrets = secretValues(processEnv, []);

  const planned = await planInit(args, { cwd, processEnv, workspaceDir });
  if (!planned.ok) {
    return redactReport(
      { ...report, tracker: planned.tracker ?? null, error: planned.error },
      secrets,
    );
  }
  const { plan } = planned;
  secrets = secretValues(plan.credentialEnv, plan.secretKeys);
  report.tracker = plan.tracker;
  report.taskQuery = plan.taskQuery;

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

  log("🩺 Running checks...");
  const { checks, entitled } = await runChecks(plan, workspaceDir, deps);
  report.checks = checks;
  let hasRepo = Boolean(applied.repo);
  try {
    hasRepo =
      hasRepo ||
      parseWorkspaceConfig(readFileSync(workspaceConfigPath(workspaceDir), "utf8")).repos.length >
        0;
  } catch {
    // The config check already reports an unreadable workspace.
  }
  report.nextSteps = nextStepsFor({ workspaceDir, entitled, hasRepo });
  report.result = checks.some((check) => check.status === "fail") ? "failure" : "success";
  return redactReport(report, secrets);
}

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: "✅",
  warn: "⚠️ ",
  fail: "❌",
  skipped: "⏭️ ",
};

/** Human-readable rendering of the report. */
export function renderNonInteractiveReport(report: NonInteractiveInitReport): string[] {
  const lines: string[] = [];
  if (report.error) {
    lines.push(`❌ ${report.error}`);
    return lines;
  }
  lines.push("", "Checks:");
  for (const check of report.checks) {
    lines.push(`  ${STATUS_ICON[check.status]} ${check.name}: ${check.message}`);
    if (check.hint) lines.push(`     → ${check.hint}`);
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    report.nextSteps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step.message}: ${step.command}`);
    });
  }
  const failed = report.checks.filter((check) => check.status === "fail").length;
  lines.push(
    "",
    report.result === "success"
      ? "✅ Worker setup complete. Nothing was started or installed."
      : `❌ Worker setup incomplete: ${failed} check(s) failed. Fix them and re-run with --yes, or run \`devintern worker doctor\`.`,
  );
  return lines;
}
