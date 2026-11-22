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
import { readFileSync } from "fs";
import {
  activeSandboxName,
  detectSandboxProviders,
  removedSandboxProviderMessage,
  resolveHarnessChainSync,
  sandboxInheritsEnclosingSandbox,
} from "@devintern/agent-harness";
import { WorkspaceConfigError, parseWorkspaceConfig } from "../workspace/config";
import type { RepoConfig, TeamConfig, WorkspaceConfig } from "../workspace/config";
import {
  buildRepoCredentialEnv,
  buildTeamEnv,
  gitHubSlugFromRemote,
  parseEnvFile,
} from "../workspace/env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import { createTrackerClient, trackerRequiredEnv } from "../trackers/manager";
import { redactUrlCredentials } from "./dashboard-workspace";
import { collectHarnessPreflight } from "../agent/sandbox";
import type { ReadinessCheck } from "./readiness";

type Env = Record<string, string | undefined>;

/** Default dashboard port, kept in sync with `DEFAULT_DASHBOARD_PORT` in `dashboard-server.ts`. */
const DEFAULT_DASHBOARD_PORT = 4400;

/** Per-probe timeout for query dry-runs and repository checks. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Minimal license result the entitlement check needs (subset of `LicenseCheckResult`). */
export interface WorkerEntitlementLike {
  valid: boolean;
  source: string;
  message: string;
  trialAvailable?: boolean;
}

/** Outcome of one repository access probe. */
export type RepoAccessResult = { ok: true; detail?: string } | { ok: false; reason: string };

export interface WorkerDoctorOptions {
  /** Explicit `workspace.toml` path (`--workspace`). */
  workspacePath?: string;
  /** Skip every network-touching probe (`--offline`). */
  offline?: boolean;
}

export interface WorkerDoctorDeps {
  /** Environment of the doctor process. Defaults to `process.env`. */
  processEnv?: Env;
  /** Workspace home when `--workspace` is not given. */
  resolveWorkspaceDir?: () => string;
  /** Count tasks matching a query against one tracker with explicit credentials. */
  dryRunQuery?: (tracker: string, env: Env, query: string) => Promise<number>;
  /** Verify a repository's remote is reachable and readable with the configured credentials. */
  checkRepoAccess?: (repo: RepoConfig, env: Env) => Promise<RepoAccessResult>;
  /** Automation entitlement for the workspace (license, trial, or grace). */
  checkEntitlement?: (workspaceDir: string) => Promise<WorkerEntitlementLike>;
  /** Agent harness chain check over the composed workspace environment. */
  checkHarness?: (env: Env) => Promise<ReadinessCheck>;
  /** Sandbox provider check over the composed workspace environment. */
  checkSandbox?: (env: Env) => Promise<ReadinessCheck>;
  /** True when the TCP port is already bound on the dashboard host. */
  isPortInUse?: (port: number) => Promise<boolean>;
  /** Timeout for each query/repository probe. */
  probeTimeoutMs?: number;
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Default dry-run: build an isolated tracker client and run the query once. */
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
 * Pick the most specific cause from `git ls-remote` stderr. Git prints the
 * real error first and generic access-rights advice last, so the first
 * `fatal:`/`error:`/`ssh:`/`Permission denied` line that is not boilerplate
 * wins; otherwise the first non-empty line. URL userinfo is stripped and the
 * result is one bounded line. Exported for tests.
 */
export function gitFailureCause(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chosen =
    lines.find((line) => GIT_CAUSE_LINE.test(line) && !GIT_BOILERPLATE_LINE.test(line)) ?? lines[0];
  if (!chosen) return undefined;
  const redacted = redactUrlCredentials(chosen).replace(/\s+/g, " ");
  return redacted.length > MAX_GIT_CAUSE_LENGTH
    ? `${redacted.slice(0, MAX_GIT_CAUSE_LENGTH - 1)}…`
    : redacted;
}

/** Run `git ls-remote` without prompting for credentials. Exported for tests. */
export function gitLsRemote(
  remote: string,
  env: Env,
  timeoutMs: number,
): Promise<RepoAccessResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["ls-remote", "--exit-code", remote, "HEAD"],
      {
        env: gitProbeEnv(env),
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolvePromise({ ok: true, detail: "remote reachable" });
          return;
        }
        const detail = gitFailureCause(String(stderr));
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

/**
 * Default repository probe. GitHub remotes with a token are checked through
 * the REST API (the same credentials the worker's mention/CI sweeps use);
 * everything else falls back to `git ls-remote`.
 */
function createDefaultRepoAccessCheck(
  timeoutMs: number,
): (repo: RepoConfig, env: Env) => Promise<RepoAccessResult> {
  return async (repo, env) => {
    const slug = gitHubSlugFromRemote(repo.remote);
    const token = env.GITHUB_TOKEN;
    if (slug && token) {
      const response = await fetch(`https://api.github.com/repos/${slug}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "devintern-worker-doctor",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return { ok: true, detail: `GitHub ${slug} readable` };
      return {
        ok: false,
        reason: `GitHub API ${response.status} for ${slug}${
          response.status === 404 ? " (missing or not visible to GITHUB_TOKEN)" : ""
        }`,
      };
    }
    return gitLsRemote(repo.remote, env, timeoutMs);
  };
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
  });
}

/** Default harness check: resolve the `AGENT_HARNESS` chain like the worker does. */
export async function defaultCheckHarness(env: Env): Promise<ReadinessCheck> {
  const label = "Agent harness";
  try {
    const chain = resolveHarnessChainSync({ raw: env.AGENT_HARNESS, warnDeprecated: false });
    const installed = chain.entries.filter((entry) => entry.installed);
    const names = chain.entries.map((entry) => entry.name).join(", ");
    if (installed.length === 0) {
      return {
        id: "harness",
        label,
        status: "fail",
        detail: chain.issues[0]?.message ?? `no harness CLI found for AGENT_HARNESS=${names}`,
        hint: "Install the agent CLI, or set AGENT_HARNESS / <HARNESS>_CLI_PATH in the workspace .env",
      };
    }
    if (chain.issues.length > 0) {
      return {
        id: "harness",
        label,
        status: "warn",
        detail: chain.issues.map((issue) => issue.message).join(" "),
        hint: "Remove or install the skipped AGENT_HARNESS entries in the workspace .env",
      };
    }
    return { id: "harness", label, status: "ok", detail: names };
  } catch (error) {
    return {
      id: "harness",
      label,
      status: "fail",
      detail: errorMessage(error),
      hint: "Set AGENT_HARNESS in the workspace .env to a registered harness",
    };
  }
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
    return { workspaceDir, configPath, config };
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
function workSourcesCheck(config: WorkspaceConfig): ReadinessCheck {
  const queries = config.teams.length > 0 ? config.teams.length : config.defaults.taskQuery ? 1 : 0;
  const detail =
    `${plural(queries, "tracker query")}, ${plural(config.automations.length, "automation")}, ` +
    `${plural(config.errorMonitors.length, "error monitor")}, ${plural(config.repos.length, "repo")}`;
  if (config.repos.length === 0) {
    return {
      id: "work-sources",
      label: "Work sources",
      status: "warn",
      detail,
      hint: "Add a repository with `devintern worker add-repo` (run inside its checkout)",
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
  },
  checks: ReadinessCheck[],
): Promise<void> {
  const { config, workspaceDir, processEnv, offline, timeoutMs, deps } = ctx;
  checks.push(workSourcesCheck(config));
  const sources = polledSources(config, workspaceDir, processEnv);

  // 2. Tracker credentials per source
  const credentialed: PolledSource[] = [];
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
    } else {
      credentialed.push(source);
      checks.push({
        id: "credentials",
        label: "Tracker credentials",
        status: "ok",
        detail: source.name,
      });
    }
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
        status: "ok",
        detail: `${source.name}: ${plural(count, "task")} match${count === 1 ? "es" : ""}`,
      });
    } catch (error) {
      checks.push({
        id: "query",
        label: "Task query",
        status: "fail",
        detail: `${source.name}: ${errorMessage(error)}`,
        hint: source.team
          ? `Fix task_query for [[teams]] "${source.team.name}" in workspace.toml (renamed status, project, or field?)`
          : "Fix [defaults].task_query in workspace.toml (renamed status, project, or field?)",
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
              hint: `Check the remote URL for "${repo.name}" and that GITHUB_TOKEN (or your git credentials) can read it`,
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
  const { workspaceDir, config } = loadWorkspace(options, deps, checks);
  const workspaceEnv: Env = { ...processEnv, ...parseEnvFile(workspaceEnvPath(workspaceDir)) };

  if (config) {
    try {
      await collectConfigScopedChecks(
        { config, workspaceDir, processEnv, offline, timeoutMs, deps },
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
    const entitlementHint =
      "Run `devintern worker login` to start the free Worker Pilot, or set LICENSE_KEY in the workspace .env (https://devintern.com/pricing)";
    try {
      const license = await (deps.checkEntitlement ?? defaultCheckEntitlement)(workspaceDir);
      checks.push(
        license.valid
          ? {
              id: "entitlement",
              label: "Automation entitlement",
              status: "ok",
              detail: license.trialAvailable
                ? "trial: Worker Pilot available; starts when the worker runs"
                : `${license.source}${license.source === "trial" || license.source === "grace" ? `: ${license.message}` : ""}`,
            }
          : {
              id: "entitlement",
              label: "Automation entitlement",
              status: "fail",
              detail: `${license.source}: ${license.message}`,
              hint: entitlementHint,
            },
      );
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

  // 6. Harness and sandbox chain (local only)
  for (const run of [
    deps.checkHarness ?? defaultCheckHarness,
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

  // 7. Dashboard port (warning only: the worker continues without it)
  if (config) {
    if (!config.workspace.dashboard) {
      checks.push({
        id: "dashboard-port",
        label: "Dashboard port",
        status: "ok",
        detail: "dashboard disabled",
      });
    } else {
      const port =
        config.workspace.dashboardPort ??
        (Number.parseInt(workspaceEnv.DASHBOARD_PORT || "", 10) || DEFAULT_DASHBOARD_PORT);
      let busy = false;
      try {
        busy = await (deps.isPortInUse ?? defaultIsPortInUse)(port);
      } catch {
        busy = false;
      }
      checks.push(
        busy
          ? {
              id: "dashboard-port",
              label: "Dashboard port",
              status: "warn",
              detail: `127.0.0.1:${port} is already in use (another worker or dashboard running?)`,
              hint: "Stop the process holding the port or set [workspace].dashboard_port in workspace.toml",
            }
          : {
              id: "dashboard-port",
              label: "Dashboard port",
              status: "ok",
              detail: `127.0.0.1:${port} free`,
            },
      );
    }
  }

  return checks;
}
