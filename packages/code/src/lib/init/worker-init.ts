/**
 * Interactive `devintern worker init`: guided unattended-worker setup.
 *
 * Writes a workspace (first import is N=1) instead of `WORKER_TASK_QUERY` in
 * `.env`, dry-runs the ready-tasks query, checks any automation license,
 * offers Sentry auto-fixes, relay pairing plus the central DevIntern App
 * (@mention events), and can install and launch a native user service
 * (systemd on Linux, launchd on macOS) — or just write its definition and
 * print the manual steps. Polling is always on; direct webhooks run as a
 * separate advanced service.
 *
 * Prompt-loop mechanics come from `@devintern/task-trackers` (shared with
 * `devintern init`); everything effectful is injectable for tests.
 */

import { randomBytes } from "crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

import {
  createDefaultSupabaseAuthConfig,
  getAuthenticatedUser,
  login,
  requireAuthenticatedUser,
  resolveLogin,
} from "@devintern/auth";
import { defaultProbe, parseEnvContent } from "@devintern/task-trackers";
import { findProjectRoot } from "@devintern/utils";

import {
  trackWorkerInitCompleted,
  trackWorkerInitFailed,
  trackWorkerInitStarted,
} from "../observability/analytics";
import type { RelayConnectOutcome, ServiceInstallOutcome } from "../observability/analytics";
import {
  GITHUB_APP_INSTALL_URL,
  hasGitHubAppCredentials,
  loadGitHubAppRecord,
} from "../code-host/github/app-setup";
import { isPromptAbort } from "../cli/prompt-abort";
import { resolveWizardPrompts } from "../cli/prompt-session";
import { WORKER_PILOT_OFFER, signInCommand } from "../account/worker-pilot";
import { readinessBlockers } from "./worker-init-readiness";
import type { ReadinessBlocker } from "./worker-init-readiness";
import { renderReadinessReport } from "../observability/readiness";
import type { ReadinessCheck } from "../observability/readiness";
import { trackerRequiredEnv } from "../trackers/manager";
import { runTrackerSetup } from "./wizard";
import { PRManager } from "../code-host/index";
import { connectRelayTarget, hasGitHubRelayRegistration, loadRelayState } from "../relay/connect";
import { parseCronOrIntervalSchedule } from "../automation/config";
import { Utils } from "../utils";
import { writeSecretFile } from "../utils/secret-file";
import { isValidTimeZone, parseTimeWindowSpec } from "../worker/schedule";
import {
  TRACKER_CAPABILITIES,
  supportsPolling,
  trackersSupportingPolling,
} from "../trackers/capabilities";
import {
  ensureWorkspaceAndAddRepo,
  writeWorkerOperatingPolicy,
  writeWorkspaceDefaults,
} from "../workspace/init";
import { loadWorkspaceConfig } from "../workspace/config";
import type { WorkspaceConfig } from "../workspace/config";
import { gitHubSlugFromRemote } from "../workspace/env";
import {
  ensureWorkspaceCodeState,
  resolveWorkspaceDir,
  workspaceCodeStateDir,
  workspaceConfigPath,
  workspaceEnvPath,
} from "../workspace/paths";
import { workspaceGitLabRelayProjects } from "./worker-connect";
import { runWorkerSentrySetup } from "./worker-sentry-setup";
import type { SentryValidationOptions } from "./worker-sentry-setup";
import {
  checkServiceManager,
  detectWorkerService,
  LAUNCHD_PLIST_NAME,
  manualServiceInstructions,
  renderLaunchdPlist,
  renderSystemdUnit,
  SYSTEMD_UNIT_NAME,
} from "../worker/service";
import type {
  RunCommandFn,
  ServiceInstallResult,
  ServiceManagerAvailability,
  ServiceState,
  WorkerServiceDeps,
} from "../worker/service";
import { installAndStartWorkerService } from "../worker/service-control";
import type { StartCheck } from "../worker/service-control";
import {
  SERVICE_RESTART_COMMAND,
  dashboardUrlFor,
  renderStartCheck,
} from "../worker/service-report";

export { renderLaunchdPlist, renderSystemdUnit } from "../worker/service";

export type PromptFn = (question: string) => Promise<string>;
export type LogFn = (message: string) => void;

/** Env keys the worker wizard used to own in `.devintern-code/.env`. */
export const WORKER_ENV_KEYS = [
  "WORKER_TASK_QUERY",
  "WORKER_POLL_INTERVAL",
  "WORKER_TASK_ARGS",
  "WEBHOOK_SECRET",
  "WEBHOOK_PORT",
] as const;

/**
 * Insert or update KEY=value lines in an env file's content. Existing keys
 * are updated in place (even when commented out); new keys are appended under
 * a worker section header.
 *
 * @param content - Current `.env` content
 * @param vars - Key/value pairs to write
 */
export function upsertEnvVars(content: string, vars: Record<string, string>): string {
  const lines = content.split("\n");
  const pending = new Map(Object.entries(vars));

  const updated = lines.map((line) => {
    const match = line.match(/^\s*#?\s*([A-Z0-9_]+)=/);
    const key = match?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  if (pending.size > 0) {
    if (updated.at(-1)?.trim() !== "") {
      updated.push("");
    }
    updated.push("# Worker daemon (devintern worker) — written by 'devintern worker init'");
    for (const [key, value] of pending) {
      updated.push(`${key}=${value}`);
    }
    updated.push("");
  }

  return updated.join("\n");
}

/** Generate a webhook signing secret (hex, 32 bytes). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export interface WorkerInitResult {
  ok: boolean;
  /** No failing readiness check (or license problem) is left after setup. */
  ready?: boolean;
  /** Not ready, but only signing in remains (no failing check): exit code 2. */
  signInOnly?: boolean;
}

export interface WorkerInitDeps {
  prompt?: PromptFn;
  /** Hidden-input prompt for tokens; defaults to `prompt` when `prompt` is injected. */
  promptSecret?: PromptFn;
  log?: LogFn;
  cwd?: string;
  /** Evaluate the ready-tasks query; returns the number of matching tasks. */
  dryRunQuery?: (query: string) => Promise<number>;
  /** Automation license check; returns a human-readable failure, or null when entitled. */
  checkAutomationLicense?: (workspaceDir: string) => Promise<string | null>;
  /** Override tracker-config step. Return tracker id, or null to abort. */
  ensureTracker?: (ctx: {
    cwd: string;
    prompt: PromptFn;
    promptSecret: PromptFn;
    log: LogFn;
  }) => Promise<string | null>;
  /**
   * Readiness checks shown at the end (the `worker doctor` checks). Without
   * it the closing line relies on the license step alone.
   */
  collectReadiness?: (workspaceDir: string) => Promise<ReadinessCheck[]>;
  /** Override workspace write. */
  bootstrapWorkspace?: (opts: {
    cwd: string;
    log: LogFn;
  }) => Promise<{ workspaceDir: string; created?: boolean; repoName?: string } | { error: string }>;
  /** Signed-in user lookup for relay onboarding. */
  getUser?: (projectRoot: string, workspaceDir?: string) => Promise<InitUserLike | null>;
  /** Interactive login for relay onboarding. */
  signIn?: (projectRoot: string, workspaceDir?: string) => Promise<InitUserLike | null>;
  /** Register relay sources while persisting state under the workspace home. */
  connectRelay?: (ctx: {
    projectRoot: string;
    workspaceDir: string;
    trackerType: string;
    log: LogFn;
  }) => Promise<boolean>;
  /** Override individual relay target setup while exercising default init orchestration. */
  runRelayConnect?: typeof connectRelayTarget;
  /** Override GitHub remote detection for the App step (`owner/name` or null). */
  detectGithubRepo?: () => Promise<string | null>;
  /** Validate Sentry credentials and project access; returns the current issue count. */
  validateSentry?: (options: SentryValidationOptions) => Promise<number>;
  /** Override the guided workspace operating-policy step. */
  configureOperatingPolicy?: (ctx: {
    workspaceDir: string;
    prompt: PromptFn;
    log: LogFn;
  }) => Promise<void>;
  /** Platform override for service-file tests. */
  platform?: NodeJS.Platform;
  /** Worker executable written into service definitions. */
  execPath?: string;
  /** Runtime executable used to launch the worker entrypoint (tests). */
  runtimePath?: string;
  /** PATH inherited by the background service (tests). */
  environmentPath?: string;
  /** File writer override for tests. */
  writeFile?: (path: string, content: string) => void;
  /** Skip the background-service offer entirely (CLI `--no-service`). */
  noService?: boolean;
  /** Home directory for the user-level service paths (tests). */
  homedir?: string;
  /** POSIX uid used by `launchctl gui/<uid>` (tests). */
  uid?: number;
  /** Command runner used by the service install (tests). */
  run?: RunCommandFn;
  /** Override installed/running detection for the service step (tests). */
  detectService?: () => Promise<ServiceState>;
  /** Override the systemd/launchd availability check for the service step (tests). */
  checkServiceManager?: () => Promise<ServiceManagerAvailability>;
  /** Override the whole install-and-launch action (tests). */
  installService?: (ctx: {
    workspaceDir: string;
    execPath: string;
    runtimePath: string;
    environmentPath: string;
    log: LogFn;
  }) => Promise<ServiceInstallResult>;
  /** Override the honest start check after installing (tests). */
  verifyServiceStart?: (ctx: { workspaceDir: string; since: number }) => Promise<StartCheck>;
}

interface InitUserLike {
  id: string;
  email: string | null;
}

/** Shared context threaded through the numbered wizard steps. */
interface InitContext {
  deps: WorkerInitDeps;
  cwd: string;
  projectRoot: string;
  log: LogFn;
  prompt: PromptFn;
  promptSecret: PromptFn;
}

type GitHubAppOutcome = "connected" | "existing" | "skipped" | "unavailable";

interface TrackerSetup {
  trackerType: string;
  trackerName: string;
  queryExample?: string;
}

interface WorkspaceSetup {
  workspaceDir: string;
  repoName?: string;
}

interface ServiceStepResult {
  /** The worker was confirmed running under the service. */
  serviceRunning: boolean;
  /** A service now manages the worker (running, starting, or failed). */
  serviceInstalled?: boolean;
  serviceInstall: ServiceInstallOutcome;
}

interface ServiceRuntime {
  platform: NodeJS.Platform;
  execPath: string;
  runtimePath: string;
  environmentPath: string;
  deps: WorkerServiceDeps;
}

/**
 * Ask a yes/no question until the answer is y/yes, n/no, or empty (the
 * default). Anything else re-asks instead of being read as either answer.
 */
export async function askYesNo(
  ctx: { prompt: PromptFn; log: LogFn },
  question: string,
  fallback: boolean,
): Promise<boolean> {
  for (;;) {
    const answer = (await ctx.prompt(question)).trim().toLowerCase();
    if (!answer) return fallback;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    ctx.log("   Enter y or n.");
  }
}

/** Prompt for the conflict-resolution mode and, when scheduled, its cadence. */
async function promptConflictPolicy(
  ctx: { workspaceDir: string; prompt: PromptFn; log: LogFn },
  current: WorkspaceConfig,
): Promise<{
  conflictResolution: WorkspaceConfig["workspace"]["conflictResolution"];
  conflictResolutionCron?: string;
  conflictResolutionInterval?: string;
}> {
  let conflictResolution = current.workspace.conflictResolution;
  for (;;) {
    const answer = (
      await ctx.prompt(
        `Conflict handling [auto/scheduled/disabled] [${current.workspace.conflictResolution}]: `,
      )
    )
      .trim()
      .toLowerCase();
    if (!answer) break;
    if (answer === "auto" || answer === "scheduled" || answer === "disabled") {
      conflictResolution = answer;
      break;
    }
    ctx.log("   Choose auto, scheduled, or disabled.");
  }

  let conflictResolutionCron: string | undefined;
  let conflictResolutionInterval: string | undefined;
  if (conflictResolution === "scheduled") {
    const existingSchedule =
      current.workspace.conflictSchedule?.cron ??
      current.workspace.conflictSchedule?.interval ??
      "0 3 * * *";
    for (;;) {
      const value =
        (
          await ctx.prompt(
            `Conflict-resolution schedule (cron or interval) [${existingSchedule}]: `,
          )
        ).trim() || existingSchedule;
      const errors: string[] = [];
      const isCron = value.split(/\s+/).length > 1;
      const parsed = parseCronOrIntervalSchedule(
        isCron ? { cron: value } : { interval: value },
        { label: "Conflict schedule" },
        errors,
      );
      if (parsed) {
        conflictResolutionCron = parsed.cron;
        conflictResolutionInterval = parsed.interval;
        break;
      }
      ctx.log(`   ${errors.join(" ")}`);
    }
  }

  return { conflictResolution, conflictResolutionCron, conflictResolutionInterval };
}

/** Prompt for active-hours windows and timezone. */
async function promptActiveSchedule(
  ctx: { workspaceDir: string; prompt: PromptFn; log: LogFn },
  currentSchedule: WorkspaceConfig["worker"]["schedule"],
): Promise<{ activeWindows: string[]; blockedWindows: string[]; timezone: string }> {
  const existingWindows =
    currentSchedule?.active.map((window) => window.spec).join(",") || "22:00-06:00";
  let activeWindows: string[] = [];
  for (;;) {
    activeWindows = (
      (await ctx.prompt(`Active windows, comma-separated [${existingWindows}]: `)).trim() ||
      existingWindows
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      activeWindows.forEach(parseTimeWindowSpec);
      break;
    } catch (error) {
      ctx.log(`   ${(error as Error).message}`);
    }
  }

  const blockedWindows = currentSchedule?.blocked.map((window) => window.spec) ?? [];
  const existingTimezone = currentSchedule?.timezone ?? "";
  let timezone = "";
  for (;;) {
    timezone =
      (await ctx.prompt(`Timezone [${existingTimezone || "worker machine local"}]: `)).trim() ||
      existingTimezone;
    if (!timezone || isValidTimeZone(timezone)) break;
    ctx.log(`   "${timezone}" is not a valid IANA timezone.`);
  }

  return { activeWindows, blockedWindows, timezone };
}

export async function configureWorkerOperatingPolicy(ctx: {
  workspaceDir: string;
  prompt: PromptFn;
  log: LogFn;
}): Promise<void> {
  const current = loadWorkspaceConfig(workspaceConfigPath(ctx.workspaceDir));
  const yesNo = (question: string, fallback: boolean) => askYesNo(ctx, question, fallback);

  const ciFailureFix = await yesNo(
    `Automatically repair failing CI on worker-created PRs? [${current.workspace.ciFailureFix ? "Y/n" : "y/N"}]: `,
    current.workspace.ciFailureFix,
  );

  const { conflictResolution, conflictResolutionCron, conflictResolutionInterval } =
    await promptConflictPolicy(ctx, current);

  const currentSchedule = current.worker.schedule;
  const limitPickup = await yesNo(
    `Limit new-task pickup to active hours? [${currentSchedule ? "Y/n" : "y/N"}]: `,
    currentSchedule !== null,
  );
  let activeWindows: string[] = [];
  let blockedWindows: string[] = [];
  let timezone = "";
  if (limitPickup) {
    ({ activeWindows, blockedWindows, timezone } = await promptActiveSchedule(
      ctx,
      currentSchedule,
    ));
  }

  writeWorkerOperatingPolicy(ctx.workspaceDir, {
    ciFailureFix,
    conflictResolution,
    conflictResolutionCron,
    conflictResolutionInterval,
    activeWindows,
    blockedWindows,
    timezone,
    catchUpMissed: currentSchedule?.catchUpMissed ?? true,
  });
  ctx.log("💾 Wrote worker operating policy to workspace.toml.");
}

function applyEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }
  const env = parseEnvContent(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    // Match dotenv's normal precedence: an explicit shell value wins.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return env;
}

/** `owner/repo` of the checkout's GitHub `origin`, or null (no origin, not GitHub). */
async function originGitHubSlug(cwd: string): Promise<string | null> {
  const result = await Utils.executeGitCommand(["remote", "get-url", "origin"], { cwd });
  const remote = result.success ? result.output.trim() : "";
  return remote ? gitHubSlugFromRemote(remote) : null;
}

export async function defaultEnsureTracker(
  cwd: string,
  prompt: PromptFn,
  promptSecret: PromptFn,
  log: LogFn,
): Promise<string | null> {
  // A legacy checkout `.env` is reused once; `add-repo` merges it into the
  // workspace env in the next step.
  const projectRoot = findProjectRoot({ startDir: cwd });
  const legacyEnvPath = resolve(projectRoot, ".devintern-code", ".env");
  if (existsSync(legacyEnvPath)) {
    const env = applyEnvFile(legacyEnvPath);
    return (env.TASK_TRACKER || process.env.TASK_TRACKER || "jira").toLowerCase();
  }

  // An existing workspace that already names a tracker needs no setup.
  const sharedEnvPath = workspaceEnvPath(resolveWorkspaceDir());
  const shared = applyEnvFile(sharedEnvPath);
  if (shared.TASK_TRACKER) return shared.TASK_TRACKER.toLowerCase();

  // `worker init --non-interactive` records the tracker in `[defaults].tracker`
  // (workspace.toml is the source of truth) and its credentials in the workspace
  // `.env`, without TASK_TRACKER. Treat that pair as configured.
  const workspaceDir = resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  const configured = existsSync(configPath) ? loadWorkspaceConfig(configPath).defaults.tracker : "";
  if (
    configured &&
    trackerRequiredEnv(configured).every((key) => shared[key] || process.env[key])
  ) {
    log(`   Using ${configured} from ${configPath}`);
    // The later steps (query dry run, readiness) build their client from this.
    process.env.TASK_TRACKER ??= configured.toLowerCase();
    return configured.toLowerCase();
  }

  log("   No tracker config yet — running that subset of `devintern init`.");
  const originSlug = await originGitHubSlug(cwd);
  const result = await runTrackerSetup(prompt, log, defaultProbe, cwd, {
    promptSecret,
    stepDefaults: originSlug ? { GITHUB_REPO: originSlug } : undefined,
    writeEnv: async (envContent) => {
      mergeIntoSharedEnv(sharedEnvPath, envContent, log);
      return sharedEnvPath;
    },
  });
  if (!result) {
    return null;
  }
  applyEnvFile(sharedEnvPath);
  return result.trackerId;
}

/**
 * Merge wizard output into the workspace's shared `.env`: keys it lacks are
 * appended; keys it already has are kept (other repos rely on them) and a
 * differing value is reported instead of overwritten.
 */
function mergeIntoSharedEnv(envPath: string, envContent: string, log: LogFn): void {
  const incoming = parseEnvContent(envContent);
  const existingText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const existing = parseEnvContent(existingText);
  const additions: string[] = [];
  const differing: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in existing)) additions.push(`${key}=${value}`);
    else if (existing[key] !== value) differing.push(key);
  }
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  const separator = existingText === "" || existingText.endsWith("\n") ? "" : "\n";
  writeSecretFile(
    envPath,
    existingText + separator + additions.map((line) => `${line}\n`).join(""),
  );
  log(`   Saved tracker settings to ${envPath}`);
  if (differing.length > 0) {
    log(
      `   ⚠️  Kept the existing values for: ${differing.join(", ")} (edit ${envPath} to change them).`,
    );
  }
}

/**
 * Resolve the auth-session path `worker init` reads and writes.
 *
 * Once the workspace is known the session must live in the workspace config
 * dir — the same store used by the daemon and task subprocesses. Otherwise signing in
 * during `worker init` would write the session beside the imported checkout,
 * where the unattended worker never looks, and its license check would fail.
 *
 * @param projectRoot - Imported repository root, used only before the workspace exists
 * @param workspaceDir - Workspace home once it has been written
 */
export function workerAuthSessionPath(projectRoot: string, workspaceDir?: string): string {
  const configDir = workspaceDir
    ? workspaceCodeStateDir(workspaceDir)
    : join(projectRoot, ".devintern-code");
  return join(configDir, ".auth-session.json");
}

/** Reuse an existing project sign-in when setting up its first worker. */
export function copyProjectSessionToWorkspace(projectRoot: string, workspaceDir: string): boolean {
  const source = join(projectRoot, ".devintern-code", ".auth-session.json");
  const target = workerAuthSessionPath(projectRoot, workspaceDir);
  if (!existsSync(source) || existsSync(target)) return false;
  mkdirSync(workspaceCodeStateDir(workspaceDir), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return true;
}

function projectAuthConfig(projectRoot: string, workspaceDir?: string) {
  return createDefaultSupabaseAuthConfig(workerAuthSessionPath(projectRoot, workspaceDir));
}

async function defaultGetUser(
  projectRoot: string,
  workspaceDir?: string,
): Promise<InitUserLike | null> {
  return getAuthenticatedUser(projectAuthConfig(projectRoot, workspaceDir));
}

async function defaultSignIn(
  projectRoot: string,
  workspaceDir?: string,
): Promise<InitUserLike | null> {
  const resolved = await resolveLogin(process.argv);
  return login(projectAuthConfig(projectRoot, workspaceDir), resolved);
}

async function detectGitHubRepo(): Promise<string | null> {
  try {
    const detected = await new PRManager().detectRepository();
    return detected.platform === "github" ? detected.repository : null;
  } catch {
    return null;
  }
}

/** GitHub slugs already represented by a workspace, deduped in config order. */
export function workspaceGitHubRepos(config: WorkspaceConfig): string[] {
  return [
    ...new Set(
      config.repos
        .map((repo) => repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote))
        .filter((repo): repo is string => Boolean(repo)),
    ),
  ];
}

async function defaultConnectRelay(
  options: {
    projectRoot: string;
    workspaceDir: string;
    trackerType: string;
    log: LogFn;
  },
  runConnect: typeof connectRelayTarget = connectRelayTarget,
): Promise<boolean> {
  const getAccessToken = async () => {
    const user = await requireAuthenticatedUser(
      projectAuthConfig(options.projectRoot, options.workspaceDir),
      "devintern worker login",
    );
    return user.accessToken;
  };
  const deps = { workingDir: options.workspaceDir, getAccessToken };
  const workspace = loadWorkspaceConfig(workspaceConfigPath(options.workspaceDir));
  const repos = workspaceGitHubRepos(workspace);
  let ok = true;

  if (repos.length > 0) {
    for (const repo of repos) {
      const repoOk = (await runConnect("github", { ...deps, repo })) === 0;
      ok = repoOk && ok;
    }
  } else {
    options.log("   No GitHub remote detected; skipping GitHub relay registration.");
  }

  const gitlabProjects = workspaceGitLabRelayProjects(workspace, options.workspaceDir);
  if (gitlabProjects.length > 0) {
    for (const project of gitlabProjects) {
      const projectOk =
        (await runConnect("gitlab", {
          ...deps,
          env: project.env,
          gitlabProject: {
            instanceUrl: project.instanceUrl,
            projectPath: project.projectPath,
          },
        })) === 0;
      ok = projectOk && ok;
    }
  } else {
    options.log("   No GitLab remote detected; skipping GitLab relay registration.");
  }

  if (options.trackerType !== "github" && options.trackerType !== "markdown") {
    const trackerOk = (await runConnect(options.trackerType, deps)) === 0;
    ok = trackerOk && ok;
  }

  return ok;
}

/**
 * Step 1: reuse the tracker config from `devintern init`, or run that subset.
 *
 * @returns The resolved tracker plus its display metadata, or null to abort.
 */
async function resolveWorkerTracker(ctx: InitContext): Promise<TrackerSetup | null> {
  ctx.log("\n1️⃣  Tracker configuration");
  const trackerType = ctx.deps.ensureTracker
    ? await ctx.deps.ensureTracker({
        cwd: ctx.cwd,
        prompt: ctx.prompt,
        promptSecret: ctx.promptSecret,
        log: ctx.log,
      })
    : await defaultEnsureTracker(ctx.cwd, ctx.prompt, ctx.promptSecret, ctx.log);
  if (!trackerType) {
    ctx.log("❌ Tracker setup did not finish. Re-run `devintern worker init`.");
    trackWorkerInitFailed("tracker_setup_incomplete");
    return null;
  }
  if (!supportsPolling(trackerType)) {
    ctx.log(`❌ Tracker '${trackerType}' does not support worker polling.`);
    ctx.log(`   Pollable trackers: ${trackersSupportingPolling().join(", ")}`);
    trackWorkerInitFailed("tracker_not_pollable");
    return null;
  }
  const capabilities = TRACKER_CAPABILITIES[trackerType];
  const trackerName = capabilities?.displayName ?? trackerType;
  ctx.log(`   Using ${trackerName}.`);
  return { trackerType, trackerName, queryExample: capabilities?.queryExample };
}

/**
 * A workspace an interrupted `worker init` left behind: no ready-tasks query
 * and no teams, so no tracker is polled yet and switching it changes nothing
 * that runs.
 */
function isHalfInitialized(config: WorkspaceConfig): boolean {
  return !config.defaults.taskQuery && config.teams.length === 0;
}

/**
 * Step 2: write the workspace (importing this repo) and guard the one-tracker
 * invariant when the workspace already existed.
 *
 * @returns The workspace directory, or null to abort.
 */
async function bootstrapWorkerWorkspace(
  ctx: InitContext,
  trackerType: string,
): Promise<WorkspaceSetup | null> {
  ctx.log("\n2️⃣  Workspace (one daemon; this repo first)");
  const bootstrap =
    ctx.deps.bootstrapWorkspace ??
    (async (opts) => {
      const result = await ensureWorkspaceAndAddRepo(opts.cwd, opts.log);
      if (!result.ok) {
        return { error: result.error };
      }
      return {
        workspaceDir: result.workspaceDir,
        created: result.created,
        repoName: result.repoName,
      };
    });
  const workspace = await bootstrap({ cwd: ctx.cwd, log: ctx.log });
  if ("error" in workspace) {
    ctx.log(`❌ ${workspace.error}`);
    trackWorkerInitFailed("workspace_error");
    return null;
  }
  if (workspace.created === false) {
    const existing = loadWorkspaceConfig(workspaceConfigPath(workspace.workspaceDir));
    if (existing.defaults.tracker !== trackerType) {
      if (!isHalfInitialized(existing)) {
        ctx.log(
          `❌ This workspace uses ${existing.defaults.tracker}, but this repo is configured for ${trackerType}.`,
        );
        ctx.log("   One worker workspace has one active tracker; keep its defaults unchanged.");
        trackWorkerInitFailed("workspace_tracker_mismatch");
        return null;
      }
      // An earlier `worker init` stopped before the query step: nothing
      // polls the old tracker yet, so finish that setup instead of refusing.
      ctx.log(
        `ℹ️  Finishing an earlier setup that stopped before the query step: tracker ${existing.defaults.tracker} → ${trackerType}.`,
      );
    }
  }
  // Record the tracker now, not with the query: setup stopped at the query
  // prompt must not leave the template's default tracker behind.
  writeWorkspaceDefaults(workspace.workspaceDir, { tracker: trackerType });
  return { workspaceDir: workspace.workspaceDir, repoName: workspace.repoName };
}

/**
 * Step 3: prompt for the ready-tasks query and validate it with a live dry run.
 *
 * @returns The accepted query.
 */
async function promptReadyQuery(
  ctx: InitContext,
  trackerName: string,
  queryExample: string | undefined,
  currentQuery: string | undefined,
): Promise<string> {
  ctx.log("\n3️⃣  Which tasks should the worker pick up?");
  ctx.log("   The query uses the same language as 'devintern --query' for your tracker.");
  if (currentQuery) {
    ctx.log("   Press Enter to keep the current query.");
  } else if (queryExample) {
    ctx.log(`   Example: ${queryExample}`);
  }

  let query = "";
  for (;;) {
    query =
      (
        await ctx.prompt(
          currentQuery ? `Ready-tasks query [${currentQuery}]: ` : "Ready-tasks query: ",
        )
      ).trim() ||
      currentQuery ||
      "";
    if (!query) {
      ctx.log("❌ A query is required — it defines what 'ready for the agent' means.");
      continue;
    }
    if (!ctx.deps.dryRunQuery) {
      break;
    }
    try {
      const count = await ctx.deps.dryRunQuery(query);
      ctx.log(`✅ Query works: ${count} task(s) match right now.`);
      if (count === 0) {
        ctx.log("   (0 matches is fine if nothing is ready yet — the worker will poll.)");
      }
      break;
    } catch (error) {
      ctx.log(`❌ Query failed against ${trackerName}: ${(error as Error).message}`);
      if (!(await askYesNo(ctx, "Edit the query and try again? [Y/n]: ", true))) {
        ctx.log("   Keeping the query as entered; fix it later in workspace.toml.");
        break;
      }
    }
  }
  return query;
}

/** Step 5: opt-in Sentry auto-fix project for the first workspace repo. */
async function runSentryStep(
  ctx: InitContext,
  workspaceDir: string,
  repoName: string | undefined,
): Promise<void> {
  ctx.log("\n5️⃣  Sentry auto-fixes (optional)");
  ctx.log("   Watch recurring production errors and run fixes through the normal PR pipeline.");
  if (
    await askYesNo(
      ctx,
      "Watch a Sentry project and create fixes for recurring errors? [y/N]: ",
      false,
    )
  ) {
    await runWorkerSentrySetup({
      workspaceDir,
      repoName,
      prompt: ctx.prompt,
      promptSecret: ctx.promptSecret,
      log: ctx.log,
      validateSentry: ctx.deps.validateSentry,
    });
  } else {
    ctx.log("   Sentry auto-fixes skipped; add [[error_monitors]] to workspace.toml later.");
  }
}

/**
 * Step 6: license is reported but never aborts setup.
 *
 * @returns The remaining license problem, null when entitled, or undefined
 *   when it was not checked
 */
async function runLicenseStep(
  ctx: InitContext,
  workspaceDir: string,
): Promise<string | null | undefined> {
  if (!ctx.deps.checkAutomationLicense) return undefined;
  ctx.log("\n6️⃣  Checking your automation license (the worker runs unattended)...");
  try {
    let failure = await ctx.deps.checkAutomationLicense(workspaceDir);
    if (failure === null) {
      ctx.log("✅ Automation license OK.");
    } else {
      ctx.log(`⚠️  ${failure}`);
      if (await askYesNo(ctx, `Sign in now to start your ${WORKER_PILOT_OFFER}? [Y/n]: `, true)) {
        try {
          const signIn = ctx.deps.signIn ?? defaultSignIn;
          const user = await signIn(ctx.projectRoot, workspaceDir);
          if (user) {
            ctx.log(`✅ Signed in as ${user.email || user.id}.`);
            failure = await ctx.deps.checkAutomationLicense(workspaceDir);
          }
        } catch (error) {
          if (isPromptAbort(error)) throw error;
          ctx.log(`⚠️  Sign-in failed: ${(error as Error).message}`);
        }
      }
      if (failure === null) {
        ctx.log(
          `✅ Free Worker Pilot available: your ${WORKER_PILOT_OFFER} starts when the worker first starts.`,
        );
      } else {
        ctx.log("   The worker will not start until this is done:");
        ctx.log(`   run \`${signInCommand()}\` to begin your ${WORKER_PILOT_OFFER},`);
        ctx.log(
          "   or get an automation license at https://devintern.com/pricing and set LICENSE_KEY in the workspace .env.",
        );
      }
    }
    return failure;
  } catch (error) {
    // Ctrl+D at the sign-in prompt stops setup; worker/cli.ts reports it.
    if (isPromptAbort(error)) throw error;
    ctx.log(
      `⚠️  License check errored (${(error as Error).message}); the worker re-checks at startup.`,
    );
    return undefined;
  }
}

/**
 * Resolve the signed-in user for relay onboarding, offering interactive login
 * when no session exists.
 *
 * @returns The user, or null when the user declines or login fails.
 */
async function resolveRelayUser(
  ctx: InitContext,
  workspaceDir: string,
): Promise<InitUserLike | null> {
  const getUser = ctx.deps.getUser ?? defaultGetUser;
  const signIn = ctx.deps.signIn ?? defaultSignIn;
  let user: InitUserLike | null = null;
  try {
    user = await getUser(ctx.projectRoot, workspaceDir);
  } catch {
    user = null;
  }

  if (user) {
    ctx.log(`   Signed in as ${user.email || user.id}.`);
    return user;
  }

  if (!(await askYesNo(ctx, "Sign in now to connect the relay? [Y/n]: ", true))) {
    return null;
  }
  try {
    user = await signIn(ctx.projectRoot, workspaceDir);
    if (user) {
      ctx.log(`✅ Signed in as ${user.email || user.id}.`);
    }
  } catch (error) {
    if (isPromptAbort(error)) throw error;
    ctx.log(`⚠️  Sign-in failed: ${(error as Error).message}`);
  }
  return user;
}

/**
 * Step 7: relay pairing. Polling stays the correctness layer; relay only
 * improves event latency.
 */
async function runRelayStep(
  ctx: InitContext,
  workspaceDir: string,
  trackerType: string,
): Promise<{ relayConnected: boolean; relayConnect: RelayConnectOutcome }> {
  let relayConnected = hasGitHubRelayRegistration(loadRelayState(workspaceDir));
  let relayConnect: RelayConnectOutcome = "skipped";
  ctx.log("\n7️⃣  Instant events (optional; polling always stays on)");
  if (
    !(await askYesNo(
      ctx,
      "React in seconds through the DevIntern relay, without opening a port? [Y/n]: ",
      true,
    ))
  ) {
    ctx.log("   Relay skipped. Polling will still pick up ready tasks and review feedback.");
    return { relayConnected, relayConnect };
  }

  const user = await resolveRelayUser(ctx, workspaceDir);
  if (!user) {
    ctx.log(
      "   Relay skipped. Run `devintern worker login`, then re-run `devintern worker init` later.",
    );
    return { relayConnected, relayConnect };
  }

  const connectRelay =
    ctx.deps.connectRelay ??
    ((options) => defaultConnectRelay(options, ctx.deps.runRelayConnect ?? connectRelayTarget));
  try {
    const connected = await connectRelay({
      projectRoot: ctx.projectRoot,
      workspaceDir,
      trackerType,
      log: ctx.log,
    });
    relayConnected = connected || hasGitHubRelayRegistration(loadRelayState(workspaceDir));
    relayConnect = connected ? "succeeded" : "partial";
    if (connected) {
      ctx.log(`✅ Relay pairing stored under ${workspaceDir}.`);
    } else {
      ctx.log(
        "⚠️  Some relay sources did not connect. Polling still works; retry with worker connect.",
      );
    }
  } catch (error) {
    relayConnect = "failed";
    ctx.log(`⚠️  Relay setup failed: ${(error as Error).message}`);
    ctx.log("   Polling still works; relay only improves event latency.");
  }
  return { relayConnected, relayConnect };
}

/** No-relay path: only a customer-owned App can deliver @mentions. */
function runNoRelayGitHubAppStep(ctx: InitContext, githubRepo: string): GitHubAppOutcome {
  ctx.log(`\n8️⃣  GitHub App on ${githubRepo} (advanced no-relay mode)`);
  if (hasGitHubAppCredentials()) {
    ctx.log("✅ Customer-owned GitHub App credentials found in the environment.");
    ctx.log("   The worker will use that App for polling, @mentions, and GitHub API calls.");
    return "existing";
  }
  ctx.log("   Relay is not connected, so the hosted DevIntern App cannot deliver events here.");
  ctx.log("   GITHUB_TOKEN still supports task PRs and review polling on the worker's own PRs.");
  ctx.log("   For air-gapped @mentions or direct webhooks, configure a customer-owned GitHub App");
  ctx.log("   with GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY_PATH/BASE64.");
  return "skipped";
}

/** Relay path: verify the central DevIntern App installation for this repo. */
function runRelayGitHubAppStep(
  ctx: InitContext,
  workspaceDir: string,
  githubRepo: string,
): GitHubAppOutcome {
  ctx.log(`\n8️⃣  DevIntern AI GitHub App on ${githubRepo} (@mentions)`);
  ctx.log("   The central App delivers events through the relay; your GITHUB_TOKEN remains local");
  ctx.log("   and handles GitHub API reads/writes. No App ID or private key is needed here.");
  ctx.log("   @devintern-ai mentions on any PR then react through the relay in seconds.");
  const existing = loadGitHubAppRecord(workspaceDir, githubRepo);
  if (
    existing?.enabled &&
    existing.repo === githubRepo.toLowerCase() &&
    typeof existing.installationId === "number" &&
    typeof existing.repositoryId === "number"
  ) {
    ctx.log(
      `✅ GitHub App already verified for ${existing.repo} (${existing.connectedAt ?? "unknown date"}).`,
    );
    return "existing";
  }
  ctx.log("   No verified GitHub App pairing was recorded.");
  ctx.log("   Run: devintern worker connect github");
  ctx.log("   The relay verifies the installation before it enables event routing.");
  return "skipped";
}

/**
 * Step 8: GitHub App. Relay-backed workspaces install the central App and keep
 * GitHub API access local through GITHUB_TOKEN; a customer-owned App is the
 * advanced, no-relay path for air-gapped/direct installations only.
 */
async function runGitHubAppStep(
  ctx: InitContext,
  workspaceDir: string,
  relayConnected: boolean,
): Promise<GitHubAppOutcome> {
  const detectGithubRepo = ctx.deps.detectGithubRepo ?? detectGitHubRepo;
  let githubRepo: string | null = null;
  try {
    githubRepo = await detectGithubRepo();
  } catch {
    githubRepo = null;
  }

  if (!githubRepo) {
    ctx.log("\n8️⃣  GitHub App (@mentions)");
    ctx.log("   No GitHub remote detected; skipping the GitHub App step.");
    return "unavailable";
  }
  if (!relayConnected) {
    return runNoRelayGitHubAppStep(ctx, githubRepo);
  }
  return runRelayGitHubAppStep(ctx, workspaceDir, githubRepo);
}

/** Ask whether to install/update the native user service. */
async function confirmServiceInstall(
  ctx: InitContext,
  state: ServiceState,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (state.installed) {
    const offer = state.active ? "restart and update" : "update";
    const bootSuffix = platform === "linux" ? " and ensure it starts at boot" : "";
    return askYesNo(
      ctx,
      `A devintern-worker service is already installed. ${offer} it${bootSuffix} now? [Y/n]: `,
      true,
    );
  }
  const action =
    platform === "linux"
      ? "Install and start the background service at boot now? [Y/n]: "
      : "Install and start the background service now? [Y/n]: ";
  return askYesNo(ctx, action, true);
}

/** Write the platform service definition and print the manual install steps. */
function printManualServiceDefinition(
  ctx: InitContext,
  platform: NodeJS.Platform,
  workspaceDir: string,
  paths: { execPath: string; runtimePath: string; environmentPath: string },
  writeFile: (path: string, content: string) => void,
): void {
  if (platform !== "linux" && platform !== "darwin") {
    ctx.log(`   No generated service definition for ${platform}; run the worker in a terminal.`);
    return;
  }
  if (platform === "linux") {
    const unitPath = join(workspaceDir, SYSTEMD_UNIT_NAME);
    writeFile(
      unitPath,
      renderSystemdUnit({
        execPath: paths.execPath,
        projectDir: workspaceDir,
        runtimePath: paths.runtimePath,
        environmentPath: paths.environmentPath,
      }),
    );
    ctx.log(`💾 Wrote ${unitPath}`);
  } else {
    const plistPath = join(workspaceDir, LAUNCHD_PLIST_NAME);
    writeFile(
      plistPath,
      renderLaunchdPlist({
        execPath: paths.execPath,
        workingDir: workspaceDir,
        runtimePath: paths.runtimePath,
        environmentPath: paths.environmentPath,
      }),
    );
    ctx.log(`💾 Wrote ${plistPath}`);
  }
  ctx.log("   Install it yourself with:");
  for (const line of manualServiceInstructions({ platform, workspaceDir })) {
    ctx.log(`     ${line}`);
  }
}

/** Run the install/restart action and report its outcome. */
async function installServiceStep(
  ctx: InitContext,
  workspaceDir: string,
  runtime: ServiceRuntime,
  printManual: () => void,
): Promise<ServiceStepResult> {
  const { execPath, runtimePath, environmentPath } = runtime;
  const since = Date.now();
  const verify = ctx.deps.verifyServiceStart;
  const { install: result, start } = ctx.deps.installService
    ? {
        install: await ctx.deps.installService({
          workspaceDir,
          execPath,
          runtimePath,
          environmentPath,
          log: ctx.log,
        }),
        start: undefined,
      }
    : await installAndStartWorkerService(
        {
          workspaceDir,
          execPath,
          runtimePath,
          environmentPath,
          waitForStart: verify ? (from) => verify({ workspaceDir, since: from }) : undefined,
        },
        runtime.deps,
      );

  if (!result.ok) {
    ctx.log(`❌ Could not install the service automatically: ${result.error}`);
    ctx.log("   Nothing was left half-installed. Install it manually:");
    printManual();
    return { serviceRunning: false, serviceInstall: "failed" };
  }

  ctx.log(
    result.updated
      ? "✅ devintern-worker service updated and restarted; waiting for the worker..."
      : "✅ devintern-worker service installed; waiting for the worker to start...",
  );
  const check =
    start ?? (verify ? await verify({ workspaceDir, since }) : { state: "running" as const });
  for (const line of renderStartCheck(check, { platform: runtime.platform, workspaceDir })) {
    ctx.log(line);
  }
  if (result.warning) {
    ctx.log(`⚠️  ${result.warning}`);
  } else if (runtime.platform === "linux") {
    ctx.log("   User lingering is on, so the service starts at boot and survives logout.");
  }
  ctx.log("   Manage it with `devintern worker service status|restart|stop|logs`.");
  return {
    serviceRunning: check.state === "running",
    serviceInstalled: true,
    serviceInstall: result.updated ? "updated" : "installed",
  };
}

/**
 * Step 9: offer to install and launch the native user service. The foreground
 * command remains an honest supported path on every platform, and a declined
 * offer (or a failed automatic install) keeps the manual
 * write-definition-and-print-instructions path alive. With readiness
 * blockers the service is not offered: it would only start a failing worker.
 */
async function runServiceStep(
  ctx: InitContext,
  workspaceDir: string,
  blockers: ReadinessBlocker[],
): Promise<ServiceStepResult> {
  ctx.log("\n9️⃣  Background service (optional)");
  const platform = ctx.deps.platform ?? process.platform;
  const writeFile = ctx.deps.writeFile ?? ((path, content) => writeFileSync(path, content, "utf8"));
  const execPath = ctx.deps.execPath ?? (process.argv[1] ? resolve(process.argv[1]) : "devintern");
  const runtimePath = ctx.deps.runtimePath ?? process.execPath;
  const environmentPath = ctx.deps.environmentPath ?? process.env.PATH ?? "";

  if (platform !== "linux" && platform !== "darwin") {
    ctx.log(`   No generated service definition for ${platform}; run the worker in a terminal.`);
    return { serviceRunning: false, serviceInstall: "unavailable" };
  }
  if (ctx.deps.noService) {
    ctx.log("   Skipped (--no-service); `devintern worker` runs the same daemon in a terminal.");
    return { serviceRunning: false, serviceInstall: "skipped" };
  }
  const serviceDeps: WorkerServiceDeps = {
    platform,
    homedir: ctx.deps.homedir,
    uid: ctx.deps.uid,
    run: ctx.deps.run,
  };
  const manager = await (
    ctx.deps.checkServiceManager ?? (() => checkServiceManager(serviceDeps))
  )();
  if (!manager.available) {
    ctx.log(`   A background service is not available here: ${manager.reason}.`);
    ctx.log("   Run the worker in the foreground instead: `devintern worker`");
    ctx.log("   (inside tmux or screen to keep it running after you disconnect).");
    return { serviceRunning: false, serviceInstall: "unavailable" };
  }

  const printManual = () =>
    printManualServiceDefinition(
      ctx,
      platform,
      workspaceDir,
      { execPath, runtimePath, environmentPath },
      writeFile,
    );
  const runtime: ServiceRuntime = {
    platform,
    execPath,
    runtimePath,
    environmentPath,
    deps: serviceDeps,
  };
  const state = ctx.deps.detectService
    ? await ctx.deps.detectService()
    : await detectWorkerService(runtime.deps);

  if (state.installed && !state.managed) {
    // Leave custom definitions and their running processes untouched.
    ctx.log("⚠️  The installed service has custom settings and will not be overwritten.");
    printManual();
    return { serviceRunning: state.active, serviceInstall: "existing" };
  }

  if (blockers.length > 0) {
    // Installing now would start a worker that exits (or crash-loops) at
    // once; the closing summary lists what to do first.
    ctx.log("   Not installed yet: the worker would not start until the steps below are done.");
    ctx.log("   Then install it with: devintern worker service install");
    return {
      serviceRunning: false,
      serviceInstalled: state.installed,
      serviceInstall: "not_ready",
    };
  }

  const accepted = await confirmServiceInstall(ctx, state, platform);
  if (!accepted) {
    printManual();
    return { serviceRunning: false, serviceInstall: "declined" };
  }
  return installServiceStep(ctx, workspaceDir, runtime, printManual);
}

/** Run the `worker doctor` checks and print them; undefined when they cannot run. */
async function logReadiness(
  ctx: InitContext,
  workspaceDir: string,
): Promise<ReadinessCheck[] | undefined> {
  if (!ctx.deps.collectReadiness) return undefined;
  ctx.log("\n📋 Readiness (the same checks as `devintern worker doctor`):");
  try {
    const checks = await ctx.deps.collectReadiness(workspaceDir);
    for (const line of renderReadinessReport(checks).lines) ctx.log(`   ${line}`);
    return checks;
  } catch (error) {
    ctx.log(`   ⚠️  Could not run the checks: ${(error as Error).message}`);
    ctx.log("   Run `devintern worker doctor` to check readiness.");
    return undefined;
  }
}

/** Print the closing summary and the GitHub App / relay guidance. */
function logWorkerNextSteps(
  ctx: InitContext,
  outcome: {
    serviceRunning: boolean;
    serviceInstalled: boolean;
    githubAppOutcome: GitHubAppOutcome;
    relayConnected: boolean;
    blockers: ReadinessBlocker[];
    dashboardUrl?: string | null;
  },
): void {
  const { serviceRunning, serviceInstalled, githubAppOutcome, relayConnected, blockers } = outcome;
  if (blockers.length === 0 && serviceInstalled && !serviceRunning) {
    ctx.log(
      "\n⚠️  Worker setup saved, but the service has not confirmed a running worker (see above).",
    );
    ctx.log("   Check it with `devintern worker service status`; after a fix:");
    ctx.log(`   ${SERVICE_RESTART_COMMAND}`);
  } else if (blockers.length > 0) {
    // Same wording as `worker doctor` and `worker init --non-interactive`:
    // a missing sign-in is one step left, not a broken setup.
    ctx.log(
      blockers.every((blocker) => blocker.action)
        ? `\n👉 Worker setup saved. One step left: sign in to begin your ${WORKER_PILOT_OFFER}.`
        : "\n⚠️  Worker setup saved, but the worker is not ready yet. Next steps:",
    );
    blockers.forEach((blocker, index) => ctx.log(`   ${index + 1}. ${blocker.text}`));
    ctx.log(
      `   ${blockers.length + 1}. Check again with \`devintern worker doctor\`, then ` +
        (serviceRunning || serviceInstalled
          ? `restart the service: ${SERVICE_RESTART_COMMAND}`
          : "install the background service with `devintern worker service install` (or run `devintern worker` in a terminal)."),
    );
  } else {
    ctx.log("\n🎉 Worker setup complete — the worker is ready.");
    ctx.log("\n📝 Next steps:");
    if (serviceRunning) {
      ctx.log("   1. The worker is already running as your user service.");
    } else {
      ctx.log("   1. Run `devintern worker`.");
    }
    ctx.log(`   2. Open ${outcome.dashboardUrl ?? "the dashboard"} to see worker status and runs.`);
    ctx.log("   3. Tasks matching your query use managed clones — your checkout is left alone.");
  }
  if (githubAppOutcome !== "skipped") return;

  if (relayConnected) {
    ctx.log("\n⚠️  Central GitHub App events are not enabled:");
    ctx.log(
      `   @mentions on PRs this worker did not create will not fire. Install ${GITHUB_APP_INSTALL_URL}`,
    );
    ctx.log(
      "   on your repositories, then re-run `devintern worker init` (or `devintern worker connect`).",
    );
  } else {
    ctx.log("\nℹ️  Running without relay or a custom GitHub App:");
    ctx.log("   GITHUB_TOKEN polling still handles the worker's own PRs.");
    ctx.log("   See the advanced GitHub integration guide if this installation must stay offline.");
  }
}

/**
 * Run the guided worker setup.
 *
 * @returns ok when setup completed and the workspace was written; ready when
 *   nothing found by the closing checks keeps the worker from running
 */
export async function runWorkerInit(deps: WorkerInitDeps = {}): Promise<WorkerInitResult> {
  const cwd = deps.cwd ?? process.cwd();
  const projectRoot = findProjectRoot({ startDir: cwd });
  const log = deps.log ?? console.log;
  const abort = { ok: false, ready: false };

  const session = await resolveWizardPrompts(deps);
  const { prompt, promptSecret } = session;

  try {
    log("👷 Setting up the unattended devintern worker.");
    trackWorkerInitStarted();

    const ctx: InitContext = { deps, cwd, projectRoot, log, prompt, promptSecret };

    // 1. Reuse tracker config from `devintern init`, or run that subset.
    const tracker = await resolveWorkerTracker(ctx);
    if (!tracker) return abort;

    // 2. Write a workspace (import this repo) with the tracker. Query lands
    // after the dry run.
    const workspace = await bootstrapWorkerWorkspace(ctx, tracker.trackerType);
    if (!workspace) return abort;
    const { workspaceDir, repoName } = workspace;

    ensureWorkspaceCodeState(workspaceDir);

    try {
      if (copyProjectSessionToWorkspace(projectRoot, workspaceDir)) {
        log("🔑 Reused this project's sign-in for the worker workspace.");
      }
    } catch (error) {
      log(`⚠️  Could not copy the project sign-in: ${(error as Error).message}`);
      log("   Run `devintern worker login` to sign in for the workspace.");
    }

    // 3. Ready-tasks query, validated with a live dry run, then task_query.
    // A re-run offers the saved query as the Enter default.
    const currentQuery = loadWorkspaceConfig(workspaceConfigPath(workspaceDir)).defaults.taskQuery;
    const query = await promptReadyQuery(
      ctx,
      tracker.trackerName,
      tracker.queryExample,
      currentQuery,
    );
    writeWorkspaceDefaults(workspaceDir, { tracker: tracker.trackerType, taskQuery: query });
    log(`💾 Wrote [defaults].task_query to ${join(workspaceDir, "workspace.toml")}`);

    // 4. Make consequential unattended behavior explicit instead of silently
    // accepting token-spending defaults.
    log("\n4️⃣  Worker operating policy");
    log("   Choose when new tasks run and how the worker maintains its pull requests.");
    await (deps.configureOperatingPolicy ?? configureWorkerOperatingPolicy)({
      workspaceDir,
      prompt,
      log,
    });

    // 5. Optional production-error source. Tracker tasks remain the worker's
    // primary input; this adds a repo-pinned Sentry project alongside them.
    await runSentryStep(ctx, workspaceDir, repoName);

    // 6. Automation license — any SKU; do not special-case workspace.
    const licenseFailure = await runLicenseStep(ctx, workspaceDir);

    // 7. Relay: polling remains the correctness layer, while a signed-in
    // worker can receive GitHub/tracker envelopes within seconds.
    const relay = await runRelayStep(ctx, workspaceDir, tracker.trackerType);

    // 8. GitHub App: relay-backed workspaces install the central App and keep
    // GitHub API access local through GITHUB_TOKEN. A customer-owned App is an
    // advanced, no-relay path for air-gapped/direct installations only.
    const githubAppOutcome = await runGitHubAppStep(ctx, workspaceDir, relay.relayConnected);

    // The doctor's verdict comes before the service step, so the wizard never
    // installs a worker that will refuse to start (no license, no agent CLI,
    // missing folder), and the closing summary never calls that complete.
    const checks = await logReadiness(ctx, workspaceDir);
    const blockers = readinessBlockers(checks, licenseFailure);

    // 9. Offer to install and launch the native user service.
    const service = await runServiceStep(ctx, workspaceDir, blockers);

    logWorkerNextSteps(ctx, {
      dashboardUrl: dashboardUrlFor(workspaceDir),
      serviceRunning: service.serviceRunning,
      serviceInstalled: service.serviceInstalled === true,
      githubAppOutcome,
      relayConnected: relay.relayConnected,
      blockers,
    });

    trackWorkerInitCompleted({
      tracker: tracker.trackerType,
      relayConnect: relay.relayConnect,
      serviceInstall: service.serviceInstall,
      githubApp: githubAppOutcome,
    });
    return {
      ok: true,
      ready: blockers.length === 0,
      signInOnly: blockers.length > 0 && blockers.every((blocker) => blocker.action),
    };
  } finally {
    session.close();
  }
}
