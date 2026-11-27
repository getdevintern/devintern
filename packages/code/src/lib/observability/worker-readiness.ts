/**
 * Workspace-scoped readiness checks behind `devintern worker doctor`: can this
 * unattended worker acquire and run work right now?
 *
 * Checks mirror the daemon's startup path so a misconfiguration that would
 * leave the worker silently idle (bad config, missing team credentials, broken
 * queries, unreadable repos, no automation entitlement, a sandbox that cannot
 * start the agent) fails here before the daemon starts.
 *
 * Read-only by construction: nothing here writes `workspace.toml`, `.env`
 * files, or the queue/state database. Every network-touching probe is
 * injectable and is skipped under `offline`, so tests never touch the network.
 * Output reuses {@link ReadinessCheck} / `renderReadinessReport` from
 * `readiness.ts`.
 */

import { execFile } from "child_process";
import { createServer } from "net";
import { dirname, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import {
  activeSandboxName,
  detectSandboxProviders,
  removedSandboxProviderMessage,
  sandboxInheritsEnclosingSandbox,
} from "@devintern/agent-harness";
import { WorkspaceConfigError, parseWorkspaceConfig } from "../workspace/config";
import { workerWorkspaceView } from "../workspace/manual-only";
import type { RepoConfig, TeamConfig, WorkspaceConfig } from "../workspace/config";
import {
  buildRepoCredentialEnv,
  buildTeamEnv,
  gitHubSlugFromRemote,
  parseEnvFile,
} from "../workspace/env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import { defaultProbe } from "@devintern/task-trackers";
import { WORKER_PILOT_OFFER, signInCommand, workerLoginCommandFor } from "../account/worker-pilot";
import { resolveDashboardPort } from "./dashboard-port";
import { entitlementCheck } from "./worker-entitlement";
import type { WorkerEntitlementLike } from "./worker-entitlement";
import { defaultQueryZeroMatchHint } from "../trackers/capabilities";
import { createTrackerClient, trackerRequiredEnv } from "../trackers/manager";
import { redactUrlCredentials } from "./dashboard-workspace";
import {
  gitCredentialEnv,
  hasConfiguredCredentialHelper,
  redactGitCredentials,
} from "../utils/git-credentials";
import { collectHarnessPreflight } from "../agent/sandbox";
import { resolveWorkerStatus } from "./dashboard-api";
import type { WorkerStatusView } from "./dashboard-api";
import type { ReadinessCheck } from "./readiness";
import { defaultCheckHarness, harnessEnvScopes } from "./harness-readiness";
import type { HarnessEnvScope } from "./harness-readiness";
import { notificationDoctorCheck } from "../notifications/delivery/doctor";
import { gitCommitIdentityCheck } from "./git-identity-readiness";
import { relayReadinessCheck } from "./relay-readiness";
import type { GitIdentityCheckInput } from "./git-identity-readiness";
import { workerLivenessCheck } from "./worker-liveness-readiness";
import { ciPermissionChecks } from "./ci-permission-readiness";
import type { CiPermissionDoctorDeps } from "./ci-permission-readiness";
import { PUSH_FIX, gitPushDryRun, readRepoPermissions } from "./repo-push-probe";
import type { PushProbeOutcome } from "./repo-push-probe";

type Env = Record<string, string | undefined>;

/** Per-probe timeout for query dry-runs and repository checks. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export type { WorkerEntitlementLike } from "./worker-entitlement";
export { entitlementCheck } from "./worker-entitlement";
export { workerDoctorClosingLine } from "./worker-liveness-readiness";
export { defaultCheckHarness } from "./harness-readiness";

/** Outcome of one repository access probe. */
export type RepoAccessResult = { ok: true; detail?: string } | { ok: false; reason: string };

export interface WorkerDoctorOptions {
  /** Explicit `workspace.toml` path (`--workspace`). */
  workspacePath?: string;
  /** Skip every network-touching probe (`--offline`). */
  offline?: boolean;
  /** Send a test message through each configured notification channel (`--test-notifications`). */
  testNotifications?: boolean;
}

export interface WorkerDoctorDeps extends CiPermissionDoctorDeps {
  /** Environment of the doctor process. Defaults to `process.env`. */
  processEnv?: Env;
  /** Workspace home when `--workspace` is not given. */
  resolveWorkspaceDir?: () => string;
  /** Count tasks matching a query against one tracker with explicit credentials. */
  dryRunQuery?: (tracker: string, env: Env, query: string) => Promise<number>;
  /** Authenticated call that proves a source's tracker credentials are accepted (throws when rejected). */
  probeCredentials?: (tracker: string, env: Env) => Promise<void>;
  /** Verify a repository's remote is reachable and readable with the configured credentials. */
  checkRepoAccess?: (repo: RepoConfig, env: Env) => Promise<RepoAccessResult>;
  /** Automation entitlement for the workspace (license, trial, or grace). */
  checkEntitlement?: (workspaceDir: string) => Promise<WorkerEntitlementLike>;
  /** Agent harness chain check over the composed workspace environment. */
  checkHarness?: (env: Env, scopes: HarnessEnvScope[]) => Promise<ReadinessCheck>;
  /** Sandbox provider check over the composed workspace environment. */
  checkSandbox?: (env: Env) => Promise<ReadinessCheck>;
  /** Which identity the worker's commits will carry (see `git-identity-readiness.ts`). */
  checkGitIdentity?: (input: GitIdentityCheckInput) => Promise<ReadinessCheck>;
  /** True when the TCP port is already bound on the dashboard host. */
  isPortInUse?: (port: number) => Promise<boolean>;
  /** Timeout for each query/repository probe. */
  probeTimeoutMs?: number;
  /** Liveness of a worker already running on this workspace (lock file, local only). */
  workerStatus?: (workspaceDir: string) => WorkerStatusView;
  /**
   * Pid of the process serving a DevIntern dashboard on `port` (from
   * `GET /api/worker`); `undefined` when nothing answers like a dashboard.
   */
  dashboardServerPid?: (port: number) => Promise<number | undefined>;
  /** Side effects of notification channels (env is replaced by the workspace env). */
  notificationChannelDeps?: Parameters<typeof notificationDoctorCheck>[3];
}

/** Timeout for asking a busy dashboard port who owns it. */
const DASHBOARD_PROBE_TIMEOUT_MS = 2_000;

/** Default ownership probe: `serverPid` from the loopback dashboard's `/api/worker`. */
async function defaultDashboardServerPid(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/worker`, {
      signal: AbortSignal.timeout(DASHBOARD_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("serverPid" in body)) return undefined;
    return typeof body.serverPid === "number" ? body.serverPid : undefined;
  } catch {
    return undefined;
  }
}

/** Default liveness: the same lock lookup `devintern worker status` uses. */
function defaultWorkerStatus(workspaceDir: string): WorkerStatusView {
  return resolveWorkerStatus(workspaceDir);
}

/** Error message without a stack trace. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject after `ms` so one hung API call cannot stall the whole report. */
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

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** Default dry-run: build an isolated tracker client and run the query once. */
/**
 * Hint for a Markdown source whose `MARKDOWN_TASKS_DIR` folder does not exist:
 * the fix is the folder, not `task_query`. Resolved against this process's
 * cwd, the same way the Markdown client resolves it.
 */
function missingMarkdownTasksDirHint(tracker: string, env: Env): string | undefined {
  const dir = env.MARKDOWN_TASKS_DIR;
  if (tracker !== "markdown" || !dir) return undefined;
  const absolute = resolve(dir);
  if (existsSync(absolute)) return undefined;
  return `Create the folder ${absolute}, or set MARKDOWN_TASKS_DIR to an existing folder that holds the task files`;
}

async function defaultDryRunQuery(tracker: string, env: Env, query: string): Promise<number> {
  const client = createTrackerClient(tracker, env);
  const result = await client.searchTasks(query);
  return result.tasks.length;
}

/**
 * Environment for a non-interactive git probe. HTTPS prompts are disabled via
 * GIT_TERMINAL_PROMPT/GIT_ASKPASS; SSH remotes get `BatchMode=yes` so ssh fails
 * fast instead of reading a key passphrase or host-key confirmation from
 * /dev/tty. A user-supplied GIT_SSH_COMMAND or GIT_SSH is left untouched.
 */
export function gitProbeEnv(env: Env): Env {
  const probeEnv: Env = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    probeEnv.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=10";
  }
  return probeEnv;
}

/** Longest stderr excerpt kept in a repository failure detail. */
const MAX_GIT_CAUSE_LENGTH = 200;

/** Lines that name a specific failure, as opposed to git's trailing advice. */
const GIT_CAUSE_LINE = /^(fatal:|error:|ssh:|remote:|.*Permission denied)/i;

/** Git's generic follow-up after the real error ("Could not read from remote repository." …). */
const GIT_BOILERPLATE_LINE =
  /could not read from remote repository|make sure you have the correct access rights|and the repository exists/i;

/**
 * Decoration lines with no content, such as GitLab's `remote: ` /
 * `remote: =====` banner around the real `remote: ERROR: …` line.
 */
const GIT_BANNER_LINE = /^(remote:)?[\s=*_-]*$/i;

/**
 * Pick the most specific cause from `git ls-remote` stderr. Git prints the
 * real error first and generic access-rights advice last, so the first
 * `fatal:`/`error:`/`ssh:`/`Permission denied` line that is not boilerplate
 * wins; otherwise the first non-empty line. Banner lines that are only a
 * `remote:` prefix or a `=`/`-` rule are skipped. URL userinfo is stripped and the
 * result is one bounded line. Exported for tests.
 */
export function gitFailureCause(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !GIT_BANNER_LINE.test(line));
  const chosen =
    lines.find((line) => GIT_CAUSE_LINE.test(line) && !GIT_BOILERPLATE_LINE.test(line)) ?? lines[0];
  if (!chosen) return undefined;
  const redacted = redactUrlCredentials(chosen).replace(/\s+/g, " ");
  return redacted.length > MAX_GIT_CAUSE_LENGTH
    ? `${redacted.slice(0, MAX_GIT_CAUSE_LENGTH - 1)}…`
    : redacted;
}

/**
 * Run `git ls-remote` without prompting for credentials, with the same
 * code-host HTTPS credentials the worker's own clone and fetch get (see
 * `gitCredentialEnv`). Exported for tests.
 */
export function gitLsRemote(
  remote: string,
  env: Env,
  timeoutMs: number,
): Promise<RepoAccessResult> {
  const args = ["ls-remote", "--exit-code", remote, "HEAD"];
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      {
        env: gitCredentialEnv(args, gitProbeEnv(env)),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolvePromise({ ok: true, detail: "remote reachable" });
          return;
        }
        const detail = gitFailureCause(redactGitCredentials(String(stderr), env));
        const cause = error.killed
          ? `timed out after ${timeoutMs / 1000}s`
          : `exited ${error.code ?? "with an error"}`;
        resolvePromise({
          ok: false,
          reason: `git ls-remote ${cause}${detail ? `: ${detail}` : ""}`,
        });
      },
    );
  });
}

/** Injectable network probes for {@link createDefaultRepoAccessCheck} (tests). */
export interface RepoAccessProbes {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  lsRemote?: (remote: string, env: Env, timeoutMs: number) => Promise<RepoAccessResult>;
  /** Whether git has its own credential helper for a URL (default: ask git). */
  hasHelper?: (url: string, env: Env) => boolean;
  /** Dry-run push with the worker's git credentials (default: {@link gitPushDryRun}). */
  pushDryRun?: (remote: string, env: Env, timeoutMs: number) => Promise<PushProbeOutcome>;
}

/**
 * Default repository probe. GitHub remotes with a token are checked through
 * the REST API (the same credentials the worker's mention/CI sweeps use) and
 * with `git ls-remote`, which gets GITHUB_TOKEN the same way the worker's
 * clone, fetch, and push do. When the API can see the repository but git is
 * refused, the reason names the cause: a configured credential helper that
 * takes precedence over GITHUB_TOKEN, or a token without contents access.
 * Everything else uses `git ls-remote` only.
 */
export function createDefaultRepoAccessCheck(
  timeoutMs: number,
  probes: RepoAccessProbes = {},
): (repo: RepoConfig, env: Env) => Promise<RepoAccessResult> {
  const fetchFn = probes.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const lsRemote = probes.lsRemote ?? gitLsRemote;
  const hasHelper =
    probes.hasHelper ?? ((url: string, env: Env) => hasConfiguredCredentialHelper(url, env));
  const pushDryRun =
    probes.pushDryRun ??
    ((remote: string, env: Env, ms: number) =>
      gitPushDryRun(remote, (args) => gitCredentialEnv(args, gitProbeEnv(env)), ms));
  return async (repo, env) => {
    const slug = gitHubSlugFromRemote(repo.remote);
    const token = env.GITHUB_TOKEN;
    if (slug && token) {
      // In parallel: the caller bounds the whole check with one timeout.
      const [response, git, push] = await Promise.all([
        fetchFn(`https://api.github.com/repos/${slug}`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "devintern-worker-doctor",
          },
          signal: AbortSignal.timeout(timeoutMs),
        }),
        lsRemote(repo.remote, env, timeoutMs),
        pushDryRun(repo.remote, env, timeoutMs).catch((error: unknown): PushProbeOutcome => ({
          status: "unknown",
          reason: errorMessage(error),
        })),
      ]);
      if (!response.ok) {
        return {
          ok: false,
          reason: `GitHub API ${response.status} for ${slug}${
            response.status === 404 ? " (missing or not visible to GITHUB_TOKEN)" : ""
          }`,
        };
      }
      // `permissions` is the token owner's role; the dry run is what the token itself may do.
      const permissions = await readRepoPermissions(response);
      const pushDenied = permissions?.push === false || push.status === "denied";
      // A refused clone names its own cause (helper precedence, Contents access);
      // a clone that only timed out says less than a definite push denial.
      if (!git.ok && !(pushDenied && /timed out/.test(git.reason))) {
        return {
          ok: false,
          reason: gitRefusedReason(
            slug,
            git.reason,
            hasHelper("https://github.com", gitProbeEnv(env)),
          ),
        };
      }
      if (pushDenied) {
        const cause = push.status === "denied" ? ` (dry-run push: ${push.reason})` : "";
        return {
          ok: false,
          reason: `GITHUB_TOKEN can read ${slug} but cannot push branches or open pull requests${cause}`,
        };
      }
      return push.status === "ok"
        ? { ok: true, detail: `GitHub ${slug} readable and writable (push verified)` }
        : { ok: true, detail: `GitHub ${slug} readable; push not verified (${push.reason})` };
    }
    return lsRemote(repo.remote, env, timeoutMs);
  };
}

/** Why git was refused a repo the API can see: the user's helper answered first, or the token lacks Contents access. */
function gitRefusedReason(slug: string, gitReason: string, userHelper: boolean): string {
  const fix = userHelper
    ? "A git credential helper configured for github.com takes precedence over GITHUB_TOKEN: sign it in again (for example `gh auth login`), or remove it so DevIntern uses GITHUB_TOKEN"
    : "Git used GITHUB_TOKEN and was refused: give the token Contents read and write access to the repository (fine-grained token) or the `repo` scope (classic token)";
  return `GITHUB_TOKEN can read ${slug} through the API, but git cannot clone it (${gitReason}). ${fix}`;
}

/** Default entitlement probe: the same automation check the daemon gates on. */
async function defaultCheckEntitlement(workspaceDir: string): Promise<WorkerEntitlementLike> {
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
    // Doctor runs in a terminal or for an agent setting up, not as the daemon.
    setup: true,
    loginCommand: "devintern worker login",
  });
}

/**
 * Default sandbox check: the same verdict `devintern sandbox` reports as
 * "next run fails", plus the harness CLI preflight through the provider.
 */
export async function defaultCheckSandbox(env: Env): Promise<ReadinessCheck> {
  const label = "Agent sandbox";
  const configured = env.AGENT_SANDBOX || "none";
  const hint =
    "Set AGENT_SANDBOX in the workspace .env to none, auto, native, nono, or docker; run `devintern sandbox` for setup steps";
  const removed = removedSandboxProviderMessage(configured);
  if (removed) {
    return { id: "sandbox", label, status: "fail", detail: `${configured}: ${removed}`, hint };
  }
  if (configured === "none") {
    return { id: "sandbox", label, status: "ok", detail: "none (agents run unsandboxed)" };
  }
  try {
    const detections = await detectSandboxProviders();
    const activeSandbox = activeSandboxName();
    if (configured !== "auto") {
      const chosen = detections.find((d) => d.provider.name === configured);
      if (!chosen) {
        const valid = ["none", "auto", ...detections.map((d) => d.provider.name)].join(", ");
        return {
          id: "sandbox",
          label,
          status: "fail",
          detail: `unknown provider "${configured}" (valid: ${valid})`,
          hint,
        };
      }
      if (!chosen.detection.available) {
        return {
          id: "sandbox",
          label,
          status: "fail",
          detail: `${configured} is not usable on this machine: ${chosen.detection.reason ?? "unavailable"}`,
          hint: `Finish the ${configured} setup (see \`devintern sandbox\`) or change AGENT_SANDBOX`,
        };
      }
    }
    const preflight = await collectHarnessPreflight(
      configured,
      detections,
      env.AGENT_HARNESS,
      activeSandbox,
    );
    const primary = preflight?.entries[0];
    if (primary && !primary.ok) {
      return {
        id: "sandbox",
        label,
        status: "fail",
        detail: `${preflight.provider}: ${primary.name} cannot start (${primary.reason ?? "unknown error"})`,
        hint: primary.suggestion ?? hint,
      };
    }
    const inherited =
      activeSandbox && sandboxInheritsEnclosingSandbox({ configured, activeSandbox });
    return {
      id: "sandbox",
      label,
      status: "ok",
      detail: inherited
        ? `${configured} (inherits the enclosing ${activeSandbox} sandbox)`
        : (preflight?.provider ?? configured),
    };
  } catch (error) {
    return { id: "sandbox", label, status: "fail", detail: errorMessage(error), hint };
  }
}

/** True when nothing else holds `port` on the dashboard's loopback host. */
function defaultIsPortInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolvePromise(error.code === "EADDRINUSE" || error.code === "EACCES");
    });
    server.once("listening", () => {
      server.close(() => resolvePromise(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

interface LoadedWorkspace {
  workspaceDir: string;
  configPath: string;
  config?: WorkspaceConfig;
  /** `manual_only` repos removed from {@link config}, for the work-sources hint. */
  manualOnlyRepos?: string[];
}

/** Read and parse `workspace.toml`, appending config checks. Never throws. */
function loadWorkspace(
  options: WorkerDoctorOptions,
  deps: WorkerDoctorDeps,
  checks: ReadinessCheck[],
): LoadedWorkspace {
  const workspaceDir = options.workspacePath
    ? dirname(resolve(options.workspacePath))
    : (deps.resolveWorkspaceDir ?? resolveWorkspaceDir)();
  const configPath = options.workspacePath
    ? resolve(options.workspacePath)
    : workspaceConfigPath(workspaceDir);
  const label = "Workspace config";

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    checks.push({
      id: "workspace-config",
      label,
      status: "fail",
      detail:
        code === "ENOENT"
          ? `no workspace.toml at ${configPath}`
          : `cannot read ${configPath}: ${errorMessage(error)}`,
      hint: options.workspacePath
        ? "Pass --workspace the path of an existing, readable workspace.toml"
        : "Run `devintern worker init` (or `devintern worker scaffold`) to create the workspace",
    });
    return { workspaceDir, configPath };
  }

  try {
    const config = parseWorkspaceConfig(text, configPath);
    checks.push({
      id: "workspace-config",
      label,
      status: "ok",
      detail:
        `${plural(config.repos.length, "repo")}, ${plural(config.teams.length, "team")}, ` +
        `${plural(config.automations.length, "automation")} (${configPath})`,
    });
    // The doctor checks what the worker runs; manual-only repos are skipped.
    const manualOnlyRepos = config.repos.filter((repo) => repo.manualOnly).map((r) => r.name);
    return { workspaceDir, configPath, config: workerWorkspaceView(config), manualOnlyRepos };
  } catch (error) {
    const problems = error instanceof WorkspaceConfigError ? error.problems : [errorMessage(error)];
    for (const problem of problems) {
      checks.push({
        id: "workspace-config",
        label,
        status: "fail",
        detail: problem,
        hint: `Edit ${configPath} to fix this entry, then rerun \`devintern worker doctor\``,
      });
    }
    return { workspaceDir, configPath };
  }
}

/** One tracker source the worker polls: a `[[teams]]` entry or `[defaults]`. */
interface PolledSource {
  tracker: string;
  team?: TeamConfig;
  query: string;
  env: Env;
  /** Display label, e.g. `jira (team "platform")`. */
  name: string;
  /** Where credentials should be added for this source. */
  credentialHint: string;
}

/** Sources the daemon would poll, with credentials layered like the daemon does. */
function polledSources(
  config: WorkspaceConfig,
  workspaceDir: string,
  processEnv: Env,
): PolledSource[] {
  if (config.teams.length > 0) {
    return config.teams.map((team) => ({
      tracker: team.tracker,
      team,
      query: team.taskQuery ?? "",
      env: buildTeamEnv(team, workspaceDir),
      name: `${team.tracker} (team "${team.name}")`,
      credentialHint: team.envFile
        ? `Add the missing variables to the workspace .env, ${team.envFile}, or [teams.env] for "${team.name}"`
        : `Add the missing variables to the workspace .env, a team env_file, or [teams.env] for "${team.name}"`,
    }));
  }
  if (!config.defaults.taskQuery || !config.defaults.tracker) return [];
  return [
    {
      tracker: config.defaults.tracker,
      query: config.defaults.taskQuery,
      // Single-defaults mode builds its client from `process.env` after the
      // workspace `.env` is applied on top.
      env: { ...processEnv, ...parseEnvFile(workspaceEnvPath(workspaceDir)) },
      name: `${config.defaults.tracker} ([defaults])`,
      credentialHint: `Add the missing variables to ${workspaceEnvPath(workspaceDir)}`,
    },
  ];
}

/** Report the empty work-source state instead of letting the worker idle silently. */
function workSourcesCheck(config: WorkspaceConfig, manualOnlyRepos: string[] = []): ReadinessCheck {
  const queries = config.teams.length > 0 ? config.teams.length : config.defaults.taskQuery ? 1 : 0;
  const detail =
    `${plural(queries, "tracker query", "tracker queries")}, ${plural(config.automations.length, "automation")}, ` +
    `${plural(config.errorMonitors.length, "error monitor")}, ${plural(config.repos.length, "repo")}`;
  if (config.repos.length === 0) {
    return {
      id: "work-sources",
      label: "Work sources",
      status: "warn",
      detail,
      hint:
        manualOnlyRepos.length > 0
          ? `${manualOnlyRepos.map((name) => `"${name}"`).join(", ")} ${manualOnlyRepos.length === 1 ? "is" : "are"} ` +
            "manual-only (registered by `devintern init`); run `devintern worker add-repo` in its checkout " +
            "so the worker uses it"
          : "Add a repository with `devintern worker add-repo` (run inside its checkout)",
    };
  }
  if (queries === 0 && config.automations.length === 0 && config.errorMonitors.length === 0) {
    return {
      id: "work-sources",
      label: "Work sources",
      status: "warn",
      detail,
      hint: "Set [defaults].task_query, add a [[teams]] entry, or add [[automations]] so the worker has work to acquire",
    };
  }
  return { id: "work-sources", label: "Work sources", status: "ok", detail };
}

/** Checks that need a parsed config: work sources, credentials, queries, repos. */
async function collectConfigScopedChecks(
  ctx: {
    config: WorkspaceConfig;
    workspaceDir: string;
    processEnv: Env;
    offline: boolean;
    timeoutMs: number;
    deps: WorkerDoctorDeps;
    manualOnlyRepos?: string[];
  },
  checks: ReadinessCheck[],
): Promise<void> {
  const { config, workspaceDir, processEnv, offline, timeoutMs, deps } = ctx;
  checks.push(workSourcesCheck(config, ctx.manualOnlyRepos));
  const sources = polledSources(config, workspaceDir, processEnv);

  // 2. Tracker credentials per source
  const credentialed: PolledSource[] = [];
  const probeCredentials =
    deps.probeCredentials ??
    ((tracker: string, env: Env) =>
      defaultProbe(
        tracker,
        Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => !!e[1])),
      ));
  for (const source of sources) {
    const missing = trackerRequiredEnv(source.tracker).filter((key) => !source.env[key]);
    if (missing.length > 0) {
      checks.push({
        id: "credentials",
        label: "Tracker credentials",
        status: "fail",
        detail: `${source.name}: missing ${missing.join(", ")}`,
        hint: source.credentialHint,
      });
      continue;
    }
    if (!offline) {
      try {
        await withTimeout(
          probeCredentials(source.tracker, source.env),
          timeoutMs,
          "credential check",
        );
      } catch (error) {
        checks.push({
          id: "credentials",
          label: "Tracker credentials",
          status: "fail",
          detail: `${source.name}: ${errorMessage(error)}`,
          hint: source.credentialHint,
        });
        continue;
      }
    }
    credentialed.push(source);
    checks.push({
      id: "credentials",
      label: "Tracker credentials",
      status: "ok",
      detail: source.name,
    });
  }

  // 3. Ready-tasks query dry-run, one API call per source
  const dryRunQuery = deps.dryRunQuery ?? defaultDryRunQuery;
  for (const source of sources) {
    if (offline) {
      checks.push({
        id: "query",
        label: "Task query",
        status: "warn",
        detail: `${source.name}: skipped (--offline)`,
        hint: "Rerun `devintern worker doctor` without --offline to dry-run the query",
      });
      continue;
    }
    if (!credentialed.includes(source)) {
      checks.push({
        id: "query",
        label: "Task query",
        status: "fail",
        detail: `${source.name}: not run (missing tracker credentials)`,
        hint: source.credentialHint,
      });
      continue;
    }
    try {
      const count = await withTimeout(
        dryRunQuery(source.tracker, source.env, source.query),
        timeoutMs,
        "query",
      );
      checks.push({
        id: "query",
        label: "Task query",
        // 0 matches is valid (nothing is ready yet), but worth a second look.
        status: count === 0 ? "warn" : "ok",
        detail: `${source.name}: ${plural(count, "task")} match${count === 1 ? "es" : ""}`,
        ...(count === 0
          ? {
              hint:
                defaultQueryZeroMatchHint(source.tracker, source.query) ??
                "The query works but matches nothing right now; the worker keeps polling. Check it selects the tasks you expect",
            }
          : {}),
      });
    } catch (error) {
      checks.push({
        id: "query",
        label: "Task query",
        status: "fail",
        detail: `${source.name}: ${errorMessage(error)}`,
        hint:
          missingMarkdownTasksDirHint(source.tracker, source.env) ??
          (source.team
            ? `Fix task_query for [[teams]] "${source.team.name}" in workspace.toml (renamed status, project, or field?)`
            : "Fix [defaults].task_query in workspace.toml (renamed status, project, or field?)"),
      });
    }
  }

  // 4. Repository access
  const checkRepoAccess = deps.checkRepoAccess ?? createDefaultRepoAccessCheck(timeoutMs);
  for (const repo of config.repos) {
    const name = `[[repos]] "${repo.name}" (${repo.remote})`;
    if (offline) {
      checks.push({
        id: "repo",
        label: "Repository access",
        status: "warn",
        detail: `${name}: skipped (--offline)`,
        hint: "Rerun `devintern worker doctor` without --offline to check repository access",
      });
      continue;
    }
    try {
      const env: Env = { ...processEnv, ...buildRepoCredentialEnv(repo, workspaceDir) };
      const result = await withTimeout(checkRepoAccess(repo, env), timeoutMs, "repository check");
      checks.push(
        result.ok
          ? {
              id: "repo",
              label: "Repository access",
              status: "ok",
              detail: `${name}${result.detail ? `: ${result.detail}` : ""}`,
            }
          : {
              id: "repo",
              label: "Repository access",
              status: "fail",
              detail: `${name}: ${result.reason}`,
              hint: result.reason.includes("cannot push")
                ? PUSH_FIX
                : `Check the remote URL for "${repo.name}" and that GITHUB_TOKEN (or your git credentials) can read it`,
            },
      );
    } catch (error) {
      checks.push({
        id: "repo",
        label: "Repository access",
        status: "fail",
        detail: `${name}: ${errorMessage(error)}`,
        hint: `Check the remote URL for "${repo.name}" and your network / credentials`,
      });
    }
  }

  // 4a. CI status access (auto-merge / CI fixes only)
  checks.push(...(await ciPermissionChecks({ config, workspaceDir, offline, timeoutMs, deps })));
}

/**
 * Dashboard port row. A busy port is reported ok only when the dashboard on it
 * says it is served by the live worker's own process; anything else warns.
 */
async function dashboardPortCheck(
  config: WorkspaceConfig,
  workspaceEnv: Env,
  worker: WorkerStatusView,
  deps: WorkerDoctorDeps,
): Promise<ReadinessCheck> {
  const base = { id: "dashboard-port", label: "Dashboard port" } as const;
  if (!config.workspace.dashboard) {
    return { ...base, status: "ok", detail: "dashboard disabled" };
  }
  const port = resolveDashboardPort(config.workspace.dashboardPort, workspaceEnv);
  let busy = false;
  try {
    busy = await (deps.isPortInUse ?? defaultIsPortInUse)(port);
  } catch {
    busy = false;
  }
  if (!busy) return { ...base, status: "ok", detail: `127.0.0.1:${port} free` };
  if (worker.status === "running" && worker.pid !== undefined) {
    // The port may not be the worker's: dashboard settings are startup-only, so
    // an edited port, or a dashboard that failed to bind, leaves someone else on it.
    const serverPid = await (deps.dashboardServerPid ?? defaultDashboardServerPid)(port).catch(
      () => undefined,
    );
    if (serverPid === worker.pid) {
      return { ...base, status: "ok", detail: `127.0.0.1:${port} in use by the running worker` };
    }
    return {
      ...base,
      status: "warn",
      detail: `127.0.0.1:${port} is in use by another process, not the running worker (pid ${worker.pid})`,
      hint:
        "Dashboard settings take effect only at worker start: stop the process holding the port " +
        "or pick another [workspace].dashboard_port, then restart the worker",
    };
  }
  return {
    ...base,
    status: "warn",
    detail: `127.0.0.1:${port} is already in use (another worker or dashboard running?)`,
    hint: "Stop the process holding the port or set [workspace].dashboard_port in workspace.toml",
  };
}

/**
 * Run every workspace readiness check and return them in display order.
 *
 * Checks that cannot run (config failed to parse, `offline`) are reported,
 * never silently dropped, and a failing probe never stops the remaining ones.
 */
export async function collectWorkerDoctorChecks(
  options: WorkerDoctorOptions = {},
  deps: WorkerDoctorDeps = {},
): Promise<ReadinessCheck[]> {
  const processEnv = deps.processEnv ?? process.env;
  const offline = options.offline === true;
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const checks: ReadinessCheck[] = [];

  // 1. Workspace config
  const { workspaceDir, config, manualOnlyRepos } = loadWorkspace(options, deps, checks);
  const workspaceEnv: Env = { ...processEnv, ...parseEnvFile(workspaceEnvPath(workspaceDir)) };

  if (config) {
    try {
      await collectConfigScopedChecks(
        { config, workspaceDir, processEnv, offline, timeoutMs, deps, manualOnlyRepos },
        checks,
      );
    } catch (error) {
      checks.push({
        id: "workspace-config",
        label: "Workspace config",
        status: "fail",
        detail: errorMessage(error),
        hint: "Check that every env_file referenced by workspace.toml exists and is readable",
      });
    }
  }

  // 4b. Git commit identity (warning only; never throws)
  const identityInput = { config, workspaceDir, processEnv: workspaceEnv, offline };
  checks.push(await (deps.checkGitIdentity ?? gitCommitIdentityCheck)(identityInput));

  // 5. Automation entitlement
  if (offline) {
    checks.push({
      id: "entitlement",
      label: "Automation entitlement",
      status: "warn",
      detail: "skipped (--offline)",
      hint: "Rerun `devintern worker doctor` without --offline to verify the license",
    });
  } else {
    const loginCommand = workerLoginCommandFor(
      options.workspacePath ?? workspaceConfigPath(workspaceDir),
    );
    const entitlementHint =
      `Run \`${signInCommand(loginCommand)}\` to start your ${WORKER_PILOT_OFFER}, ` +
      "or set LICENSE_KEY in the workspace .env (https://devintern.com/pricing)";
    try {
      const license = await (deps.checkEntitlement ?? defaultCheckEntitlement)(workspaceDir);
      checks.push(entitlementCheck(license, loginCommand, entitlementHint));
    } catch (error) {
      checks.push({
        id: "entitlement",
        label: "Automation entitlement",
        status: "fail",
        detail: errorMessage(error),
        hint: entitlementHint,
      });
    }
  }

  // 6. Harness and sandbox chain (local only). The harness check resolves CLI
  // paths from each repo's spawn env, the way the task subprocess does.
  const scopes = harnessEnvScopes(processEnv, workspaceDir, config);
  const checkHarness = deps.checkHarness ?? defaultCheckHarness;
  for (const run of [
    (env: Env) => checkHarness(env, scopes),
    deps.checkSandbox ?? defaultCheckSandbox,
  ]) {
    try {
      checks.push(await run(workspaceEnv));
    } catch (error) {
      checks.push({
        id: "sandbox",
        label: "Agent harness / sandbox",
        status: "fail",
        detail: errorMessage(error),
        hint: "Run `devintern sandbox` for details",
      });
    }
  }

  // 6b. Relay pairing (local state only; runs under --offline too)
  checks.push(relayReadinessCheck(workspaceDir, config));

  // 7. Worker liveness (local lock file only; runs under --offline too)
  let worker: WorkerStatusView = { status: "stopped" };
  try {
    worker = (deps.workerStatus ?? defaultWorkerStatus)(workspaceDir);
  } catch {
    // Unreadable lock: report as before, without a Worker row.
  }
  const workerCheck = workerLivenessCheck(worker);
  if (workerCheck) checks.push(workerCheck);

  // 8. Dashboard port (warning only: the worker continues without it)
  if (config) checks.push(await dashboardPortCheck(config, workspaceEnv, worker, deps));

  // 9. Notification delivery channels (warning only; never throws)
  if (config) {
    checks.push(
      await notificationDoctorCheck(config, workspaceEnv, options, deps.notificationChannelDeps),
    );
  }

  return checks;
}
