/** Workspace-only `devintern worker connect` orchestration. */

import { existsSync } from "fs";
import { dirname, resolve } from "path";

import { workerLoginCommandFor } from "../account/worker-pilot";
import { Utils } from "../utils";
import { parseGitLabHostAliases, parseGitRemoteUrl } from "../code-host/index";
import {
  connectRelayTarget,
  hasGitHubRelayRegistration,
  hasGitLabRelayRegistration,
  loadRelayState,
} from "../relay/connect";
import type {
  ConnectOutcome,
  RelayConnectTarget,
  WorkspaceRelayConnectDeps,
} from "../relay/connect";
import { loadWorkspaceConfig } from "../workspace/config";
import type { WorkspaceConfig } from "../workspace/config";
import { buildRepoEnv, buildTeamEnv, gitHubSlugFromRemote, parseEnvFile } from "../workspace/env";
import {
  ensureWorkspaceCodeState,
  resolveWorkspaceDir,
  workspaceConfigPath,
  workspaceEnvPath,
} from "../workspace/paths";
import {
  buildConnectDocument,
  buildTargetDocument,
  exitCodeForResult,
} from "./worker-connect-json";
import type { ConnectJsonDocument, ConnectTargetJson } from "./worker-connect-json";
import { runNonInteractiveSentrySetup, splitProjectSlugs } from "./worker-sentry-noninteractive";
import { runWorkerSentrySetup } from "./worker-sentry-setup";
import type { SentrySetupPromptFn, SentryValidationOptions } from "./worker-sentry-setup";

const TRACKER_TARGETS = new Set(["linear", "asana", "trello", "azure-devops", "jira"]);

/**
 * Every target `worker connect` accepts. Single source of truth for command
 * validation and for bounding `worker_connect` analytics target cardinality.
 */
export const WORKER_CONNECT_TARGETS: ReadonlySet<string> = new Set([
  "all",
  "github",
  "gitlab",
  ...TRACKER_TARGETS,
  "sentry",
  "status",
]);

const WORKER_CONNECT_HELP = `Usage: devintern worker connect [target] [options]

Connect an integration to the workspace worker. Code-host and tracker targets use
the DevIntern relay; Sentry adds a directly polled error-monitor project.

Targets:
  github             Verify unpaired GitHub repositories through the App
  gitlab             Install relay hooks for GitLab.com or self-managed projects
  linear             Register a Linear webhook
  asana              Register an Asana webhook
  trello             Register a Trello webhook
  azure-devops       Register Azure DevOps hooks
  jira                Print Jira's one-time webhook setup instructions
  sentry              Add and validate a Sentry auto-fix project
  status              Show relay status and unverified workspace repositories

Options:
  --workspace <path>   Use this workspace.toml
  --team <name>        Use one team's tracker credentials
  --repo <name>        Repository that owns a Sentry project
  --disconnect         Remove managed GitLab hooks; polling remains enabled
  --takeover           Move registrations another worker on this account serves
                       to this worker (it then receives their events alone)
  --json               Print one JSON document on stdout (text goes to stderr)
  -h, --help           Display this help message

GitHub without waiting for the browser:
  --no-wait            Print the App install URL, record the pairing, and exit 0
  --status             Check the recorded pairing once and finish registration
                       when it is complete (alias: --resume)

Sentry without a terminal (token from SENTRY_AUTH_TOKEN or --env-file, never a flag):
  --org <slug>         Sentry organization slug
  --project <slug>     Sentry project slug (repeat or comma-separate for several)
  --sentry-url <url>   Self-hosted or regional Sentry URL (default https://sentry.io)
  --query <filter>     Sentry issue search filter (optional)
  --env-file <path>    File with SENTRY_AUTH_TOKEN; must be mode 0600
  --yes                Refresh the token of a monitor that already exists
  --non-interactive    Never prompt (implied by --json and the Sentry flags above)

Tracker targets use the selected team's env_file/inline env over the workspace
.env. Team-scoped registrations let multiple teams use the same tracker. With no
target, GitHub and GitLab code hosts are connected.`;

export interface WorkerConnectCommandDeps {
  workspaceDir?: string;
  workspacePath?: string;
  getAccessToken?: () => Promise<string>;
  runConnect?: typeof connectRelayTarget;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
  cwd?: string;
  prompt?: SentrySetupPromptFn;
  validateSentry?: (options: SentryValidationOptions) => Promise<number>;
  /**
   * Reuse a `parseConnectArgs` result from the caller so analytics attribution
   * and command execution share one parse instead of drifting apart.
   */
  parsed?: ParsedConnectArgs;
  /** Collects the per-target `--json` documents; set only while a JSON run is active. */
  sink?: JsonSink;
  /** Where the `--json` document goes (tests); defaults to stdout. */
  writeStdout?: (text: string) => void;
  /** Where human text goes during a `--json` run (tests); defaults to stderr. */
  writeStderr?: (text: string) => void;
  /** Credential environment for the non-interactive Sentry flow (tests); defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Documents and error lines gathered during a `--json` run. */
export interface JsonSink {
  docs: ConnectTargetJson[];
  errors: string[];
}

export interface ParsedConnectArgs {
  target: string;
  workspacePath?: string;
  team?: string;
  repo?: string;
  help: boolean;
  disconnect: boolean;
  json: boolean;
  /** GitHub: begin the pairing and exit without waiting for the browser. */
  noWait: boolean;
  /** GitHub: check the recorded pairing once. */
  status: boolean;
  /** Move registrations owned by another worker of the account to this one. */
  takeover: boolean;
  /** Sentry: never prompt. */
  nonInteractive: boolean;
  yes: boolean;
  organization?: string;
  projects: string[];
  sentryUrl?: string;
  query?: string;
  envFile?: string;
  error?: string;
}

type ConnectValueFlag =
  | "--workspace"
  | "--team"
  | "--repo"
  | "--org"
  | "--project"
  | "--sentry-url"
  | "--query"
  | "--env-file";

const SECRET_FLAGS = new Set(["--token", "--auth-token", "--sentry-token", "--sentry-auth-token"]);

/** Sentry-only options, for the "only valid for sentry" check. */
const SENTRY_ONLY_FLAGS: ReadonlyArray<[string, (parsed: ParsedConnectArgs) => boolean]> = [
  ["--org", (parsed) => parsed.organization !== undefined],
  ["--project", (parsed) => parsed.projects.length > 0],
  ["--sentry-url", (parsed) => parsed.sentryUrl !== undefined],
  ["--query", (parsed) => parsed.query !== undefined],
  ["--env-file", (parsed) => parsed.envFile !== undefined],
  ["--yes", (parsed) => parsed.yes],
  ["--non-interactive", (parsed) => parsed.nonInteractive],
];

/**
 * Parse `worker connect` arguments. Exported so the CLI entry point can parse
 * once and pass the result to the command via `deps.parsed`, keeping analytics
 * attribution and execution in sync.
 */
export function parseConnectArgs(args: string[]): ParsedConnectArgs {
  const parsed: ParsedConnectArgs = {
    target: "all",
    help: false,
    disconnect: false,
    json: false,
    noWait: false,
    status: false,
    takeover: false,
    nonInteractive: false,
    yes: false,
    projects: [],
  };
  let targetSet = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--disconnect") {
      parsed.disconnect = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--no-wait") {
      parsed.noWait = true;
    } else if (arg === "--status" || arg === "--resume") {
      parsed.status = true;
    } else if (arg === "--takeover") {
      parsed.takeover = true;
    } else if (arg === "--non-interactive") {
      parsed.nonInteractive = true;
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (SECRET_FLAGS.has(arg) || arg.startsWith("--token=")) {
      parsed.error =
        "Auth tokens are never accepted as flags. Set SENTRY_AUTH_TOKEN in the environment " +
        "or pass --env-file <path> (mode 0600).";
      return parsed;
    } else if (
      arg === "--workspace" ||
      arg === "--team" ||
      arg === "--repo" ||
      arg === "--org" ||
      arg === "--project" ||
      arg === "--sentry-url" ||
      arg === "--query" ||
      arg === "--env-file"
    ) {
      const value = args[index + 1];
      if (!value || (value.startsWith("-") && arg !== "--query")) {
        parsed.error = `${arg} requires a value.`;
        return parsed;
      }
      assignValueFlag(parsed, arg, value);
      index++;
    } else if (arg.startsWith("-")) {
      parsed.error = `Unknown option: ${arg}`;
      return parsed;
    } else {
      if (targetSet) {
        parsed.error = `Unexpected argument: ${arg}`;
        return parsed;
      }
      parsed.target = arg.toLowerCase();
      targetSet = true;
    }
  }
  return parsed;
}

function assignValueFlag(parsed: ParsedConnectArgs, flag: ConnectValueFlag, value: string): void {
  if (flag === "--workspace") parsed.workspacePath = value;
  else if (flag === "--team") parsed.team = value;
  else if (flag === "--repo") parsed.repo = value;
  else if (flag === "--org") parsed.organization = value;
  else if (flag === "--project") parsed.projects.push(value);
  else if (flag === "--sentry-url") parsed.sentryUrl = value;
  else if (flag === "--query") parsed.query = value;
  else parsed.envFile = value;
}

/** GitHub slugs represented by the workspace, deduplicated in config order. */
export function workspaceRelayRepos(config: WorkspaceConfig): string[] {
  return [
    ...new Set(
      config.repos
        .map((repo) => repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote))
        .filter((repo): repo is string => Boolean(repo)),
    ),
  ];
}

/** GitHub repositories that still need verified App pairing. */
export function unverifiedWorkspaceRelayRepos(
  config: WorkspaceConfig,
  workspaceDir: string,
): string[] {
  const state = loadRelayState(workspaceDir);
  return workspaceRelayRepos(config).filter((repo) => !hasGitHubRelayRegistration(state, repo));
}

export interface WorkspaceGitLabRelayProject {
  repoName: string;
  instanceUrl: string;
  projectPath: string;
  env: Record<string, string | undefined>;
}

/** GitLab projects represented by workspace remotes, deduplicated by instance and path. */
export function workspaceGitLabRelayProjects(
  config: WorkspaceConfig,
  workspaceDir: string,
): WorkspaceGitLabRelayProject[] {
  const projects = new Map<string, WorkspaceGitLabRelayProject>();
  for (const repo of config.repos) {
    const env = buildRepoEnv(repo, workspaceDir);
    const remote = parseGitRemoteUrl(repo.remote, {
      gitlabBaseUrl: env.GITLAB_CODE_HOST_URL,
      gitlabHostAliases: parseGitLabHostAliases(env.GITLAB_CODE_HOST_ALIASES),
    });
    if (remote?.provider !== "gitlab") continue;
    const key = `${remote.instanceUrl.toLowerCase()}\n${remote.projectPath.toLowerCase()}`;
    if (!projects.has(key)) {
      projects.set(key, {
        repoName: repo.name,
        instanceUrl: remote.instanceUrl,
        projectPath: remote.projectPath,
        env,
      });
    }
  }
  return [...projects.values()];
}

/** Validate the parsed flags; returns an error message or undefined when valid. */
function validateConnectArgs(parsed: ParsedConnectArgs): string | undefined {
  if (!WORKER_CONNECT_TARGETS.has(parsed.target)) {
    return (
      `Unsupported connect target '${parsed.target}'. ` +
      "Available: github, gitlab, linear, asana, trello, azure-devops, jira, sentry, status."
    );
  }
  if (
    parsed.team &&
    (parsed.target === "github" ||
      parsed.target === "gitlab" ||
      parsed.target === "all" ||
      parsed.target === "status" ||
      parsed.target === "sentry")
  ) {
    return "--team is only valid for tracker connect targets.";
  }
  if (parsed.repo && parsed.target !== "sentry") {
    return "--repo is only valid for Sentry connect.";
  }
  if (parsed.disconnect && parsed.target !== "gitlab") {
    return "--disconnect is only valid for the GitLab connect target.";
  }
  if (parsed.target !== "sentry") {
    const sentryOnly = SENTRY_ONLY_FLAGS.find(([, isSet]) => isSet(parsed));
    if (sentryOnly) return `${sentryOnly[0]} is only valid for the Sentry connect target.`;
  }
  if (parsed.noWait && parsed.target !== "github" && parsed.target !== "all") {
    return "--no-wait is only valid for the GitHub connect target.";
  }
  if (parsed.status && parsed.target !== "github") {
    return "--status is only valid for the GitHub connect target.";
  }
  if (parsed.takeover && (parsed.target === "status" || parsed.target === "sentry")) {
    return "--takeover is only valid for relay connect targets (github, gitlab, trackers).";
  }
  if (parsed.takeover && parsed.disconnect) {
    return "--takeover and --disconnect cannot be combined.";
  }
  if (parsed.noWait && parsed.status) {
    return "--no-wait and --status cannot be combined: --no-wait starts a pairing, --status checks it.";
  }
  return undefined;
}

interface ConnectWorkspace {
  workspaceDir: string;
  configPath: string;
  config: WorkspaceConfig;
}

/**
 * Resolve the workspace/config paths, load `workspace.toml`, and layer the
 * workspace `.env` under any existing shell values.
 *
 * @returns The resolved workspace, or an error message to print.
 */
function resolveConnectWorkspace(
  parsed: ParsedConnectArgs,
  deps: WorkerConnectCommandDeps,
): ConnectWorkspace | { error: string } {
  const selectedWorkspacePath = deps.workspacePath ?? parsed.workspacePath;
  const workspaceDir =
    deps.workspaceDir ??
    (selectedWorkspacePath ? dirname(resolve(selectedWorkspacePath)) : resolveWorkspaceDir());
  const configPath = selectedWorkspacePath
    ? resolve(selectedWorkspacePath)
    : workspaceConfigPath(workspaceDir);

  if (!existsSync(configPath)) {
    return {
      error: `No workspace found at ${configPath}. Run \`devintern worker init\` first.`,
    };
  }

  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig(configPath);
  } catch (error) {
    return { error: (error as Error).message };
  }

  for (const [key, value] of Object.entries(parseEnvFile(workspaceEnvPath(workspaceDir)))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { workspaceDir, configPath, config };
}

/** Build relay-connect deps, memoizing a single access-token lookup. */
function createWorkspaceConnectDeps(
  deps: WorkerConnectCommandDeps,
  workspaceDir: string,
  parsed: ParsedConnectArgs,
): WorkspaceRelayConnectDeps {
  let accessTokenPromise: Promise<string> | undefined;
  return {
    workingDir: workspaceDir,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
    getAccessToken: deps.getAccessToken
      ? () => (accessTokenPromise ??= deps.getAccessToken!())
      : undefined,
    noWait: parsed.noWait,
    githubStatus: parsed.status,
    takeover: parsed.takeover,
  };
}

/** Drive GitHub then GitLab connect for the `all` target, sharing one token lookup. */
async function runAllConnectTargets(
  config: WorkspaceConfig,
  workspaceDir: string,
  configPath: string,
  deps: WorkerConnectCommandDeps,
  noWait: boolean,
  takeover: boolean,
): Promise<number> {
  let accessTokenPromise: Promise<string> | undefined;
  const sharedDeps: WorkerConnectCommandDeps = {
    ...deps,
    parsed: undefined,
    workspaceDir,
    workspacePath: configPath,
    getAccessToken: deps.getAccessToken
      ? () => (accessTokenPromise ??= deps.getAccessToken!())
      : undefined,
  };
  let failures = 0;
  const takeoverArgs = takeover ? ["--takeover"] : [];
  if (workspaceRelayRepos(config).length > 0) {
    const githubArgs = noWait ? ["github", "--no-wait"] : ["github"];
    if ((await runWorkerConnectCommand([...githubArgs, ...takeoverArgs], sharedDeps)) !== 0) {
      failures++;
    }
  } else {
    console.log("   No GitHub repositories found; skipping GitHub relay setup.");
  }
  if (workspaceGitLabRelayProjects(config, workspaceDir).length > 0) {
    if ((await runWorkerConnectCommand(["gitlab", ...takeoverArgs], sharedDeps)) !== 0) failures++;
  } else {
    console.log("   No GitLab repositories found; skipping GitLab relay setup.");
  }
  return failures === 0 ? 0 : 1;
}

/** Repository for a Sentry project: `--repo`, else the checkout in `cwd` when it matches one. */
async function resolveSentryRepo(
  config: WorkspaceConfig,
  parsed: ParsedConnectArgs,
  deps: WorkerConnectCommandDeps,
): Promise<string | undefined> {
  if (parsed.repo || config.repos.length <= 1) return parsed.repo;
  const remote = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
    cwd: deps.cwd ?? process.cwd(),
  });
  return remote.success
    ? config.repos.find((repo) => repo.remote === remote.output.trim())?.name
    : undefined;
}

const SENTRY_NO_TERMINAL_MESSAGE =
  "'devintern worker connect sentry' is interactive; run it in a terminal, or pass " +
  "--org <slug> --project <slug> [--repo <name>] [--sentry-url <url>] " +
  "with SENTRY_AUTH_TOKEN in the environment or --env-file <path> (mode 0600). Add --json " +
  "for machine-readable output.";

/** Whether this Sentry connect should run without prompts. */
function sentryRunsNonInteractively(parsed: ParsedConnectArgs): boolean {
  return (
    parsed.nonInteractive ||
    parsed.json ||
    parsed.organization !== undefined ||
    parsed.projects.length > 0 ||
    parsed.sentryUrl !== undefined ||
    parsed.query !== undefined ||
    parsed.envFile !== undefined ||
    parsed.yes
  );
}

/** Add or validate Sentry error-monitor projects, prompting or from flags. */
async function runSentryConnectTarget(
  config: WorkspaceConfig,
  workspaceDir: string,
  parsed: ParsedConnectArgs,
  deps: WorkerConnectCommandDeps,
): Promise<number> {
  if (!sentryRunsNonInteractively(parsed)) {
    if (!deps.prompt && !process.stdin.isTTY) {
      console.error(`❌ ${SENTRY_NO_TERMINAL_MESSAGE}`);
      deps.sink?.docs.push({
        target: "sentry",
        result: "failure",
        code: "no_terminal",
        error: SENTRY_NO_TERMINAL_MESSAGE,
      });
      return 1;
    }
    const result = await runWorkerSentrySetup({
      workspaceDir,
      repoName: await resolveSentryRepo(config, parsed, deps),
      prompt: deps.prompt,
      validateSentry: deps.validateSentry,
    });
    return result.ok ? 0 : 1;
  }

  const result = await runNonInteractiveSentrySetup({
    workspaceDir,
    repoName: await resolveSentryRepo(config, parsed, deps),
    flags: {
      organization: parsed.organization,
      projects: splitProjectSlugs(parsed.projects),
      baseUrl: parsed.sentryUrl,
      query: parsed.query,
      envFile: parsed.envFile,
      yes: parsed.yes,
    },
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    validateSentry: deps.validateSentry,
  });
  if (!result.ok) {
    console.error(`❌ ${result.error}`);
    deps.sink?.docs.push({
      target: "sentry",
      result: "failure",
      code: result.code,
      error: result.error,
      ...(result.missing ? { missing: result.missing } : {}),
    });
    return 1;
  }
  for (const monitor of result.monitors) {
    console.log(
      `✅ Sentry ${monitor.organization}/${monitor.project}: monitor "${monitor.id}" ${monitor.action} ` +
        `(${monitor.unresolvedIssues} unresolved issue(s) currently match).`,
    );
  }
  for (const warning of result.warnings) console.log(`⚠️  ${warning}`);
  deps.sink?.docs.push({
    target: "sentry",
    result: "connected",
    monitors: result.monitors,
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  });
  return 0;
}

/** Resolve a tracker target's team selection into an env overlay, or an error. */
function resolveTrackerTeamEnv(
  config: WorkspaceConfig,
  workspaceDir: string,
  target: RelayConnectTarget,
  requestedTeam: string | undefined,
): { error: string } | { env?: Record<string, string | undefined>; team?: string } {
  const matchingTeams = config.teams.filter(
    (team) => team.tracker.toLowerCase() === target.toLowerCase(),
  );
  if (matchingTeams.length > 1 && !requestedTeam) {
    return {
      error:
        `${matchingTeams.length} teams use ${target} (${matchingTeams.map((team) => team.name).join(", ")}). ` +
        "Select one with --team <name>.",
    };
  }
  const selectedTeam = requestedTeam
    ? config.teams.find((team) => team.name === requestedTeam)
    : matchingTeams[0];
  if (requestedTeam && !selectedTeam) {
    return { error: `Unknown workspace team '${requestedTeam}'.` };
  }
  if (selectedTeam && selectedTeam.tracker.toLowerCase() !== target.toLowerCase()) {
    return { error: `Team '${selectedTeam.name}' uses ${selectedTeam.tracker}, not ${target}.` };
  }
  if (!selectedTeam) {
    return {};
  }
  console.log(`🔗 Connecting ${target} for team '${selectedTeam.name}'.`);
  return {
    env: { ...process.env, ...buildTeamEnv(selectedTeam, workspaceDir) },
    team: selectedTeam.name,
  };
}

/** Print relay status plus any workspace repos/projects still missing registrations. */
async function runStatusConnectTarget(
  config: WorkspaceConfig,
  workspaceDir: string,
  runConnect: typeof connectRelayTarget,
  connectDeps: WorkspaceRelayConnectDeps,
): Promise<number> {
  const result = await runConnect("status", connectDeps);
  if (result !== 0) return result;

  const missing = unverifiedWorkspaceRelayRepos(config, workspaceDir);
  if (missing.length === 0) {
    console.log("   All workspace GitHub repositories are verified.");
  } else {
    console.log(`   Unverified workspace repositories: ${missing.join(", ")}`);
    console.log(
      '   Repositories under an already-paired installation with "All repositories" access ' +
        "verify automatically when the worker starts or reloads its config.",
    );
    console.log("   Otherwise run: devintern worker connect github");
  }
  const relayState = loadRelayState(workspaceDir);
  const gitlabProjects = workspaceGitLabRelayProjects(config, workspaceDir);
  const missingGitLab = gitlabProjects.filter(
    (project) => !hasGitLabRelayRegistration(relayState, project.instanceUrl, project.projectPath),
  );
  if (gitlabProjects.length > 0 && missingGitLab.length === 0) {
    console.log("   All workspace GitLab projects have local relay registrations.");
  } else if (missingGitLab.length > 0) {
    console.log(
      `   GitLab projects without local relay registration: ${missingGitLab.map((project) => project.projectPath).join(", ")}`,
    );
    console.log("   Run: devintern worker connect gitlab");
  }
  return 0;
}

/** Install (or, with `--disconnect`, remove) relay hooks for every GitLab project. */
async function runGitLabConnectTargets(
  config: WorkspaceConfig,
  workspaceDir: string,
  disconnect: boolean,
  runConnect: typeof connectRelayTarget,
  connectDeps: WorkspaceRelayConnectDeps,
): Promise<number> {
  const projects = workspaceGitLabRelayProjects(config, workspaceDir);
  if (projects.length === 0) {
    console.error("❌ No GitLab repositories found in workspace.toml.");
    return 1;
  }
  let failures = 0;
  for (const project of projects) {
    console.log(`🔗 Connecting GitLab project ${project.projectPath} (${project.repoName}).`);
    const result = await runConnect("gitlab", {
      ...connectDeps,
      env: project.env,
      gitlabProject: {
        instanceUrl: project.instanceUrl,
        projectPath: project.projectPath,
      },
      disconnectGitLab: disconnect,
    });
    if (result !== 0) failures++;
  }
  if (failures > 0) {
    console.error(`❌ ${failures} GitLab project hook setup(s) failed; polling remains enabled.`);
    return 1;
  }
  console.log("✅ All workspace GitLab projects are connected for relay delivery.");
  return 0;
}

/**
 * Group repositories by owning account.
 *
 * A GitHub App installation lives on one account, so repositories from the same
 * owner can share one install selection; repositories from different owners
 * each need their own authorization step.
 */
function groupReposByOwner(repos: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const repo of repos) {
    const owner = repo.split("/")[0]?.toLowerCase() ?? repo.toLowerCase();
    const group = groups.get(owner);
    if (group) group.push(repo);
    else groups.set(owner, [repo]);
  }
  return [...groups.values()];
}

/** Verify every workspace GitHub repository, skipping ones already paired. */
async function runGitHubConnectTargets(
  config: WorkspaceConfig,
  workspaceDir: string,
  runConnect: typeof connectRelayTarget,
  connectDeps: WorkspaceRelayConnectDeps,
): Promise<number> {
  const repos = workspaceRelayRepos(config);
  if (connectDeps.githubStatus) {
    // Resumes the pairing recorded by an earlier run; the repositories come from it.
    return runConnect("github", connectDeps);
  }
  if (repos.length === 0) {
    console.error("❌ No GitHub repositories found in workspace.toml.");
    return 1;
  }
  let failures = 0;
  let pairingStarted = false;
  let connectRan = false;
  const tracked: WorkspaceRelayConnectDeps = {
    ...connectDeps,
    onOutcome(outcome) {
      if (outcome.kind === "pending") pairingStarted = true;
      connectDeps.onOutcome?.(outcome);
    },
  };
  for (const group of groupReposByOwner(repos)) {
    // Re-read after every pairing: the previous group's callback updated the
    // verified repositories in the relay state.
    const state = loadRelayState(workspaceDir);
    const unverified = group.filter((repo) => !hasGitHubRelayRegistration(state, repo));
    for (const repo of group.filter((repo) => hasGitHubRelayRegistration(state, repo))) {
      console.log(`✅ ${repo} is already verified; skipping.`);
    }
    if (unverified.length === 0) continue;
    connectRan = true;
    const result = await runConnect("github", { ...tracked, repos: unverified });
    if (result !== 0) failures++;
    // One recorded pairing at a time: finish this one with --status, then run again.
    if (pairingStarted) break;
  }
  if (!connectRan) {
    // Nothing to pair, but the relay worker identity still registers so this
    // worker claims (or, with --takeover, moves) the verified repositories.
    if ((await runConnect("github", { ...tracked, repos, identityOnly: true })) !== 0) failures++;
  }
  if (failures > 0) {
    console.error(`❌ ${failures} workspace repository pairing(s) failed.`);
    return 1;
  }
  if (pairingStarted) {
    // The per-account step already printed the URL and the `--status` command.
    console.log("⏳ GitHub pairing started.");
    return 0;
  }
  console.log("✅ All workspace GitHub repositories are verified for relay delivery.");
  return 0;
}

/** Route console output to stderr while a `--json` run owns stdout; lines on `console.error` are kept. */
async function withLogsOnStderr<T>(
  sink: JsonSink,
  writeStderr: (text: string) => void,
  run: () => Promise<T>,
): Promise<T> {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const line = (values: unknown[]) => `${values.join(" ")}\n`;
  console.log = (...values: unknown[]) => writeStderr(line(values));
  console.info = console.log;
  console.warn = console.log;
  console.error = (...values: unknown[]) => {
    sink.errors.push(values.join(" "));
    writeStderr(line(values));
  };
  try {
    return await run();
  } finally {
    Object.assign(console, saved);
  }
}

/** ` --workspace <path>` for next-step commands when the workspace is not the default. */
function workspaceSuffix(configPath: string): string {
  return workerLoginCommandFor(configPath).slice("devintern worker login".length);
}

/**
 * Run the public, workspace-only `devintern worker connect` command.
 *
 * With `--json` the one JSON document goes to stdout and every human line to
 * stderr; the exit code is 0 (connected or pending), 2 (sign-in needed), or 1.
 */
export async function runWorkerConnectCommand(
  args: string[],
  deps: WorkerConnectCommandDeps = {},
): Promise<number> {
  const parsed = deps.parsed ?? parseConnectArgs(args);
  if (!parsed.json || deps.sink) return runParsedConnect(parsed, deps);

  const sink: JsonSink = { docs: [], errors: [] };
  const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  await withLogsOnStderr(sink, writeStderr, () => runParsedConnect(parsed, { ...deps, sink }));
  const doc: ConnectJsonDocument = buildConnectDocument(parsed.target, sink.docs);
  writeStdout(`${JSON.stringify(doc, null, 2)}\n`);
  return exitCodeForResult(doc.result);
}

/** Record a failure that happened before any target ran. */
function failEarly(message: string, target: string, deps: WorkerConnectCommandDeps): number {
  console.error(`❌ ${message}`);
  deps.sink?.docs.push({ target, result: "failure", error: message });
  return 1;
}

async function runParsedConnect(
  parsed: ParsedConnectArgs,
  deps: WorkerConnectCommandDeps,
): Promise<number> {
  if (parsed.help) {
    console.log(WORKER_CONNECT_HELP);
    return 0;
  }
  if (parsed.error) return failEarly(parsed.error, parsed.target, deps);
  const validationError = validateConnectArgs(parsed);
  if (validationError) return failEarly(validationError, parsed.target, deps);

  const workspace = resolveConnectWorkspace(parsed, deps);
  if ("error" in workspace) return failEarly(workspace.error, parsed.target, deps);
  const { workspaceDir, configPath, config } = workspace;
  ensureWorkspaceCodeState(workspaceDir);
  const runConnect = deps.runConnect ?? connectRelayTarget;

  if (parsed.target === "all") {
    return runAllConnectTargets(
      config,
      workspaceDir,
      configPath,
      deps,
      parsed.noWait,
      parsed.takeover,
    );
  }
  if (parsed.target === "sentry") {
    return runSentryConnectTarget(config, workspaceDir, parsed, deps);
  }

  const target = parsed.target as RelayConnectTarget;
  const connectDeps = createWorkspaceConnectDeps(deps, workspaceDir, parsed);
  const outcomes: ConnectOutcome[] = [];
  connectDeps.onOutcome = (outcome) => outcomes.push(outcome);
  const errorsBefore = deps.sink?.errors.length ?? 0;

  const code = await runRelayTarget(target, parsed, config, workspaceDir, runConnect, connectDeps);
  if (deps.sink) {
    deps.sink.docs.push(
      buildTargetDocument({
        target,
        exitCode: code,
        outcomes,
        errorLines: deps.sink.errors.slice(errorsBefore),
        workspaceSuffix: workspaceSuffix(configPath),
        workerId: loadRelayState(workspaceDir)?.worker?.workerId,
      }),
    );
  }
  return code;
}

async function runRelayTarget(
  target: RelayConnectTarget,
  parsed: ParsedConnectArgs,
  config: WorkspaceConfig,
  workspaceDir: string,
  runConnect: typeof connectRelayTarget,
  connectDeps: WorkspaceRelayConnectDeps,
): Promise<number> {
  if (TRACKER_TARGETS.has(target)) {
    const teamEnv = resolveTrackerTeamEnv(config, workspaceDir, target, parsed.team);
    if ("error" in teamEnv) {
      console.error(`❌ ${teamEnv.error}`);
      return 1;
    }
    if (teamEnv.env) connectDeps.env = teamEnv.env;
    if (teamEnv.team) connectDeps.team = teamEnv.team;
  }

  if (target === "status") {
    return runStatusConnectTarget(config, workspaceDir, runConnect, connectDeps);
  }
  if (target === "gitlab") {
    return runGitLabConnectTargets(
      config,
      workspaceDir,
      parsed.disconnect,
      runConnect,
      connectDeps,
    );
  }
  if (target === "github") {
    return runGitHubConnectTargets(config, workspaceDir, runConnect, connectDeps);
  }
  return runConnect(target, connectDeps);
}
