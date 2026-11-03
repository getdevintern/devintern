import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { findEnvFile } from "@devintern/utils";
import { DEFAULT_GITLAB_BASE_URL } from "../clients/gitlab.ts";
import { REPO_SCOPED_ENV_KEYS } from "./repo-scoped-env-keys.ts";
import { getMissingRequiredEnv, isTrackerId } from "./tracker-meta.ts";
import type { TrackerConfig, TrackerType } from "./types.ts";

export const BUNDLED_TRELLO_API_KEY = "b2d5d1ced28b515c6eb66c40187400b0";

/** Marker the DevIntern worker sets on every subprocess it spawns. */
export const WORKER_SUBPROCESS_ENV = "DEVINTERN_WORKER_SUBPROCESS";

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the DevIntern workspace home directory.
 *
 * `DEVINTERN_WORKSPACE_DIR` wins when set (tests and non-default workspaces);
 * otherwise the default is `~/.devintern`.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns Workspace home directory.
 */
export function resolveWorkspaceDir(env: EnvLike = process.env): string {
  const override = env.DEVINTERN_WORKSPACE_DIR?.trim();
  return override || join(homedir(), ".devintern");
}

/**
 * Resolve the workspace-level `.env` path (`<workspace>/.env`).
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns Absolute path of the workspace `.env`.
 */
export function resolveWorkspaceEnvPath(env: EnvLike = process.env): string {
  return join(resolveWorkspaceDir(env), ".env");
}

/** Strip a TOML comment while respecting quoted strings. */
function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === "\\") {
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Remove matching TOML quotes from a scalar value. */
function unquoteTomlValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * One `[[teams]]` entry from a DevIntern `workspace.toml`.
 *
 * Only the fields that affect destination selection are parsed; the worker's
 * validator remains the source of truth for the full schema.
 */
interface WorkspaceTeamEntry {
  name?: string;
  tracker?: string;
  repo?: string;
}

/** One `[[repos]]` entry from a DevIntern `workspace.toml`. */
interface WorkspaceRepoEntry {
  name?: string;
  remote?: string;
}

/** One `[[routing.rules]]` entry from a DevIntern `workspace.toml`. */
interface WorkspaceRoutingEntry {
  team?: string;
  repo?: string;
}

/** Destination-relevant subset of a DevIntern `workspace.toml`. */
interface ParsedWorkspaceToml {
  defaultTracker?: string;
  teams: WorkspaceTeamEntry[];
  repos: WorkspaceRepoEntry[];
  routing: WorkspaceRoutingEntry[];
}

/** Parser state for the table currently being read. */
interface WorkspaceTableState {
  section: string;
  team?: WorkspaceTeamEntry;
  repo?: WorkspaceRepoEntry;
  rule?: WorkspaceRoutingEntry;
}

/** Start a table/array-of-tables and create its entry when it tracks a destination. */
function openWorkspaceTable(
  parsed: ParsedWorkspaceToml,
  state: WorkspaceTableState,
  section: string,
): void {
  state.section = section;
  state.team = undefined;
  state.repo = undefined;
  state.rule = undefined;

  if (section === "teams") {
    state.team = {};
    parsed.teams.push(state.team);
  } else if (section === "repos") {
    state.repo = {};
    parsed.repos.push(state.repo);
  } else if (section === "routing.rules") {
    state.rule = {};
    parsed.routing.push(state.rule);
  }
}

/** Copy one known field from the current table into its entry. */
function applyWorkspaceAssignment(
  parsed: ParsedWorkspaceToml,
  state: WorkspaceTableState,
  key: string,
  value: string,
): void {
  switch (state.section) {
    case "defaults":
      if (key === "tracker") parsed.defaultTracker ??= value;
      return;
    case "teams":
      if (!state.team) return;
      if (key === "tracker") state.team.tracker ??= value;
      else if (key === "name") state.team.name ??= value;
      else if (key === "repo") state.team.repo ??= value;
      return;
    case "repos":
      if (!state.repo) return;
      if (key === "name") state.repo.name ??= value;
      else if (key === "remote") state.repo.remote ??= value;
      return;
    case "routing.rules":
      if (!state.rule) return;
      if (key === "team") state.rule.team ??= value;
      else if (key === "repo") state.rule.repo ??= value;
      return;
    default:
      return;
  }
}

/** Parse the tracker/repo/team fields `devpm` needs to resolve one destination. */
function parseWorkspaceToml(text: string): ParsedWorkspaceToml {
  const parsed: ParsedWorkspaceToml = { teams: [], repos: [], routing: [] };
  const state: WorkspaceTableState = { section: "" };

  for (const line of text.split("\n")) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;

    const table = /^\[\[?([^\]]+)\]\]?$/.exec(trimmed);
    if (table) {
      openWorkspaceTable(parsed, state, table[1]?.trim() ?? "");
      continue;
    }

    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!assignment) continue;

    const value = unquoteTomlValue(assignment[2]!.trim());
    if (!value) continue;
    applyWorkspaceAssignment(parsed, state, assignment[1]!, value);
  }

  return parsed;
}

/**
 * Read the tracker id from a DevIntern `workspace.toml`.
 *
 * The canonical workspace keeps the tracker in `[defaults].tracker` (teams may
 * override it), while the shared `.env` holds only credentials. `devpm` needs
 * the tracker id to interpret those credentials, so fall back to this file when
 * no env layer supplies `TASK_TRACKER`.
 *
 * @param text - Raw `workspace.toml` contents.
 * @returns `[defaults].tracker`, else the first `[[teams]].tracker`, else undefined.
 */
export function parseWorkspaceTracker(text: string): string | undefined {
  const parsed = parseWorkspaceToml(text);
  return parsed.defaultTracker ?? parsed.teams.find((team) => team.tracker)?.tracker;
}

/**
 * Normalize a git remote URL for comparison (`host/path`, no credentials,
 * protocol, port, `.git` suffix, or trailing slash).
 *
 * @param remote - Raw remote such as `git@github.com:acme/api.git`.
 * @returns Comparable `host/owner/repo`, or undefined when unparseable.
 */
function normalizeGitRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (!trimmed) return undefined;

  let host: string | undefined;
  let path: string | undefined;

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const url = new URL(trimmed);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  }

  const normalizedPath = path
    ?.replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!host || !normalizedPath) return undefined;
  return `${host.toLowerCase()}/${normalizedPath.toLowerCase()}`;
}

const execFileAsync = promisify(execFile);

/**
 * Match the current checkout's git origin against `[[repos]].remote`.
 *
 * @returns The repo name from `workspace.toml`, or undefined when no remote matches.
 */
async function detectWorkspaceRepoName(
  repos: readonly WorkspaceRepoEntry[],
  projectDir: string | undefined,
): Promise<string | undefined> {
  if (repos.length === 0) return undefined;

  let origin: string;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: projectDir ?? process.cwd(),
    });
    origin = stdout.trim();
  } catch {
    // Not a checkout, or no origin: no repo match.
    return undefined;
  }

  const normalized = normalizeGitRemote(origin);
  if (!normalized) return undefined;
  return repos.find((repo) => repo.remote && normalizeGitRemote(repo.remote) === normalized)?.name;
}

/**
 * Pick the workspace team that owns the current checkout.
 *
 * Precedence: `DEVINTERN_WORKSPACE_TEAM`, then a `[[teams]]` fixed `repo`
 * match, then a unique team-scoped `[[routing.rules]]` repo match. Returns
 * undefined when the checkout cannot be mapped unambiguously, so the caller can
 * fall back to `[defaults].tracker`.
 *
 * @param parsed - Parsed `workspace.toml` subset.
 * @param env - Environment carrying the worker's team/repo markers.
 * @param projectDir - Checkout used for git origin matching.
 */
async function selectWorkspaceTeam(
  parsed: ParsedWorkspaceToml,
  env: EnvLike,
  projectDir: string | undefined,
): Promise<WorkspaceTeamEntry | undefined> {
  const teamName = env.DEVINTERN_WORKSPACE_TEAM?.trim();
  if (teamName) {
    const normalized = teamName.toLowerCase();
    const named = parsed.teams.find(
      (team) => team.name?.toLowerCase() === normalized && team.tracker,
    );
    if (named) return named;
  }

  const repoName =
    env.DEVINTERN_WORKSPACE_REPO?.trim() ||
    (await detectWorkspaceRepoName(parsed.repos, projectDir));
  if (!repoName) return undefined;

  const fixed = parsed.teams.find((team) => team.repo === repoName && team.tracker);
  if (fixed) return fixed;

  // Team names are validated case-insensitively by the canonical workspace
  // parser, so dedupe by lower-case name to keep `Growth`/`growth` one team.
  const routedNames = new Map(
    parsed.routing
      .filter((rule) => rule.repo === repoName && rule.team)
      .map((rule) => [rule.team!.toLowerCase(), rule.team!] as const),
  );
  if (routedNames.size === 1) {
    const [routedName] = routedNames.keys();
    const routed = parsed.teams.find(
      (team) => team.name?.toLowerCase() === routedName && team.tracker,
    );
    if (routed) return routed;
  }

  return undefined;
}

/** Options for {@link resolveWorkspaceTracker}. */
export interface ResolveWorkspaceTrackerOptions {
  /** Environment carrying worker markers (defaults to `process.env`). */
  env?: EnvLike;
  /** Checkout compared against `[[repos]].remote` (defaults to `process.cwd()`). */
  projectDir?: string;
}

/**
 * Load the tracker id for this checkout from `<workspace>/workspace.toml`.
 *
 * Multi-team workspaces map one repository to one team; picking the first team
 * would route a checkout at another team's board. The team is resolved from the
 * worker's `DEVINTERN_WORKSPACE_TEAM`/`DEVINTERN_WORKSPACE_REPO` markers or the
 * local git origin, then `[defaults].tracker` and finally the first team are
 * fallbacks for workspaces without a per-repo mapping.
 *
 * @param workspaceDir - Workspace home (defaults to {@link resolveWorkspaceDir}).
 * @param options - Environment and checkout used for team selection.
 * @returns Tracker id, or undefined when the file is missing/unreadable.
 */
export async function resolveWorkspaceTracker(
  workspaceDir: string = resolveWorkspaceDir(),
  options: ResolveWorkspaceTrackerOptions = {},
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(workspaceDir, "workspace.toml"), "utf8");
  } catch {
    // Optional workspace config
    return undefined;
  }

  const parsed = parseWorkspaceToml(text);
  const team = await selectWorkspaceTeam(parsed, options.env ?? process.env, options.projectDir);
  return (
    team?.tracker ?? parsed.defaultTracker ?? parsed.teams.find((entry) => entry.tracker)?.tracker
  );
}

/**
 * Throw when `TRACKER_META.requiredEnv` entries are missing for `backendType`.
 * Trello keeps a custom authorize-URL message; other trackers share one format.
 */
function assertRequiredTrackerEnv(backendType: string): void {
  if (!isTrackerId(backendType)) return;

  const missing = getMissingRequiredEnv(backendType, process.env);
  if (missing.length === 0) return;

  if (backendType === "trello") {
    const apiKey = process.env.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY;
    const authorizeUrl = apiKey
      ? `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=${apiKey}`
      : "https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=YOUR_API_KEY";
    throw new Error(
      `Trello backend requires TRELLO_API_TOKEN.\n` +
        `Generate one by visiting:\n${authorizeUrl}\n` +
        `Then set TRELLO_API_TOKEN in your .env`,
    );
  }

  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}\n` +
      "Please copy .env.example to .env and fill in the values.",
  );
}

/**
 * Sanitize a Jira domain by removing protocol and trailing slashes.
 *
 * @param domain - Raw Jira base URL or hostname.
 * @returns Hostname suitable for API requests (e.g. `your-org.atlassian.net`).
 */
export function sanitizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Normalize a GitLab instance URL.
 *
 * Unlike Jira domains, GitLab needs the protocol kept (self-hosted instances
 * may run on plain http). Adds `https://` when no protocol is present and
 * strips trailing slashes; blank values fall back to
 * {@link DEFAULT_GITLAB_BASE_URL}.
 *
 * @param raw - Raw `GITLAB_BASE_URL` value (may be empty).
 * @returns Instance root URL suitable for API requests (e.g. `https://gitlab.com`).
 */
export function sanitizeGitlabBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_GITLAB_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

/**
 * Normalize a `GITLAB_PROJECT` value into an API project path.
 *
 * Accepts `group/repo`, subgroup paths (`group/sub/repo`), numeric project
 * IDs, and pasted web URLs (`https://host/group/repo/-/issues`). The `/-/`
 * suffix and everything after it is dropped.
 *
 * @param value - Raw `GITLAB_PROJECT` environment variable value.
 * @returns Project path for API URLs (encoded later by {@link GitLabClient}).
 * @throws When the value does not identify a project.
 */
export function parseGitLabProject(value: string): string {
  const trimmed = value.trim();
  // Drop the instance origin from pasted web URLs, then cut at "/-/".
  let path = trimmed.replace(/^https?:\/\/[^/]+/i, "");
  const dashIndex = path.indexOf("/-/");
  if (dashIndex >= 0) {
    path = path.slice(0, dashIndex);
  }
  path = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      // Malformed escapes (`%zz`) throw URIError; keep the raw segment so the
      // validation below reports a friendly error instead.
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

  if (/^\d+$/.test(path)) {
    return path;
  }

  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(path)) {
    throw new Error(
      `Invalid GITLAB_PROJECT "${value}". Expected group/repo (subgroups allowed, ` +
        "e.g. acme/team/my-app) or a numeric project ID.",
    );
  }

  return path;
}

/**
 * Parse `GITHUB_REPO` into owner and repo name.
 *
 * Accepts `owner/repo` (preferred) or a repo name with `GITHUB_OWNER` (legacy).
 *
 * @param repoValue - Value of the `GITHUB_REPO` environment variable.
 * @param legacyOwner - Optional `GITHUB_OWNER` fallback when `repoValue` has no slash.
 * @returns Parsed owner, repo, and combined `owner/repo` string.
 * @throws When the value cannot be parsed into a valid repository reference.
 */
export function parseGitHubRepo(
  repoValue: string,
  legacyOwner?: string,
): { owner: string; repo: string; repository: string } {
  const trimmed = repoValue.trim();

  if (trimmed.includes("/")) {
    const slashIndex = trimmed.indexOf("/");
    const owner = trimmed.slice(0, slashIndex);
    const repo = trimmed.slice(slashIndex + 1);
    if (!owner || !repo) {
      throw new Error(
        `Invalid GITHUB_REPO "${repoValue}". Expected owner/repo (e.g. acme/my-app).`,
      );
    }
    return { owner, repo, repository: `${owner}/${repo}` };
  }

  if (legacyOwner?.trim()) {
    const owner = legacyOwner.trim();
    return { owner, repo: trimmed, repository: `${owner}/${trimmed}` };
  }

  throw new Error(
    `Invalid GITHUB_REPO "${repoValue}". Set GITHUB_REPO=owner/repo (e.g. acme/my-app).`,
  );
}

/**
 * Apply dotenv-style `KEY=value` lines to `process.env`.
 *
 * @param envContent - Raw `.env` contents.
 * @param skip - Keys to leave untouched (e.g. keys another layer owns).
 * @returns Names of the keys written, in file order.
 */
function applyEnvContent(envContent: string, skip?: ReadonlySet<string>): string[] {
  const applied: string[] = [];
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        let value = valueParts.join("=").trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        const name = key.trim();
        if (skip?.has(name)) continue;
        process.env[name] = value;
        applied.push(name);
      }
    }
  }
  return applied;
}

/**
 * Load one optional env file into `process.env`; missing files are ignored.
 *
 * @returns Names of the keys written (empty when the file is missing/unreadable).
 */
async function applyEnvFile(envPath: string, skip?: ReadonlySet<string>): Promise<string[]> {
  try {
    return applyEnvContent(await readFile(envPath, "utf8"), skip);
  } catch {
    // Optional .env file
    return [];
  }
}

/**
 * Load environment variables from the nearest `.env` file.
 *
 * Searches upward from `baseDir` (default: current working directory), checking
 * `{configDirName}/.env` first, then a plain `.env`, at each level.
 * Existing process env vars are overwritten for keys present in the file.
 * Missing or unreadable files are ignored.
 *
 * @param configDirName - Config folder name (e.g. `.devintern-pm`).
 * @param baseDir - Directory to start the upward search from (defaults to cwd).
 * @returns Resolves when loading completes.
 */
export async function loadEnvFromConfigDir(
  configDirName: string,
  baseDir: string = process.cwd(),
): Promise<void> {
  const envPath = findEnvFile({ configDirName, startDir: baseDir });

  if (!envPath) {
    return;
  }

  await applyEnvFile(envPath);
}

/**
 * Load the env layers that feed {@link parseTrackerConfigFromEnv}.
 *
 * Legacy callers (desktop) keep the single-file lookup: nearest
 * `{configDirName}/.env`, else nearest plain `.env`. CLI callers enable
 * `workspaceEnvFallback`, which merges (lowest to highest) the DevIntern
 * workspace `.env`, the nearest project plain `.env`, and finally the nearest
 * `{configDirName}/.env`.
 *
 * Worker-spawned subprocesses (`DEVINTERN_WORKER_SUBPROCESS=1`) load no files
 * at all on the CLI path: the worker already injected the exact per-repo/team
 * layer (with `TASK_TRACKER` and the credentials pinned last), and re-reading
 * checkout or workspace files would clobber it. `devintern` follows the same
 * rule for its own worker subprocesses. Hosts that only read project files
 * (desktop `loadConfig(projectDir)`) opt out of `workspaceEnvFallback`, so the
 * inherited marker must not hide a configured project `.env` from them.
 *
 * In the workspace layer, the tracker for this checkout comes from
 * `workspace.toml` (team mapping first, then `[defaults].tracker`) when
 * present (a stale shared `.env` value must not re-route the CLI), and
 * repo-scoped keys are never inherited from the shared file: they describe a
 * different repository's destination.
 */
async function loadTrackerEnv(
  configDirName: string,
  baseDir: string,
  workspaceEnvFallback: boolean,
): Promise<void> {
  // Only CLI callers opt into the worker subprocess contract; project-only
  // hosts (pm-desktop) must keep reading their own `.devintern-pm/.env` even
  // when launched from a shell that inherited the marker.
  if (workspaceEnvFallback && process.env[WORKER_SUBPROCESS_ENV] === "1") {
    return;
  }

  if (!workspaceEnvFallback) {
    await loadEnvFromConfigDir(configDirName, baseDir);
    return;
  }

  const configEnvPath = findEnvFile({
    configDirName,
    startDir: baseDir,
    includePlainEnv: false,
  });
  const plainEnvPath = findEnvFile({ startDir: baseDir });
  const workspaceEnvPath = resolveWorkspaceEnvPath();
  const workspaceTracker = await resolveWorkspaceTracker(undefined, { projectDir: baseDir });
  const inheritedTracker = process.env.TASK_TRACKER;

  const workspaceSkip = new Set<string>(REPO_SCOPED_ENV_KEYS);
  if (workspaceTracker) workspaceSkip.add("TASK_TRACKER");

  const seen = new Set<string>();
  const projectApplied = new Set<string>();
  const resolvedWorkspacePath = resolve(workspaceEnvPath);

  for (const envPath of [workspaceEnvPath, plainEnvPath, configEnvPath]) {
    if (!envPath) continue;
    const resolvedPath = resolve(envPath);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);

    const isWorkspaceLayer = resolvedPath === resolvedWorkspacePath;
    const applied = await applyEnvFile(resolvedPath, isWorkspaceLayer ? workspaceSkip : undefined);
    if (!isWorkspaceLayer) {
      for (const key of applied) projectApplied.add(key);
    }
  }

  // Canonical workspaces keep the tracker in `workspace.toml`, not the shared
  // `.env`. Fill it only when neither a project env file nor inherited process
  // env selected one.
  if (workspaceTracker && !projectApplied.has("TASK_TRACKER") && !inheritedTracker) {
    process.env.TASK_TRACKER = workspaceTracker;
  }
}

/**
 * Parse tracker configuration from the current process environment.
 *
 * Call {@link loadEnvFromConfigDir} first when loading from a project config directory.
 *
 * @returns Resolved {@link TrackerConfig} for the selected task tracker.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export function parseTrackerConfigFromEnv(): TrackerConfig {
  const backendType = (process.env.TASK_TRACKER || "jira") as TrackerType;
  const verbose = process.env.DEVINTERN_VERBOSE === "1" || process.env.DEVINTERN_VERBOSE === "true";
  const backendConfig: TrackerConfig["backend"] = {
    type: backendType,
    directory: process.env.MARKDOWN_TASKS_DIR,
  };

  let jiraConfig: TrackerConfig["jira"];
  let linearConfig: TrackerConfig["linear"];
  let trelloConfig: TrackerConfig["trello"];
  let azureDevOpsConfig: TrackerConfig["azureDevOps"];
  let asanaConfig: TrackerConfig["asana"];
  let githubConfig: TrackerConfig["github"];
  let gitlabConfig: TrackerConfig["gitlab"];

  // Markdown keeps MARKDOWN_TASKS_DIR optional here (backends default the path);
  // other trackers validate against TRACKER_META.requiredEnv.
  if (backendType !== "markdown") {
    assertRequiredTrackerEnv(backendType);
  }

  if (backendType === "jira") {
    jiraConfig = {
      domain: sanitizeDomain(process.env.JIRA_BASE_URL!),
      email: process.env.JIRA_EMAIL!,
      apiToken: process.env.JIRA_API_TOKEN!,
      defaultProjectKey: process.env.JIRA_DEFAULT_PROJECT_KEY!,
      verbose,
    };
  }

  if (backendType === "linear") {
    linearConfig = {
      apiKey: process.env.LINEAR_API_KEY!,
      defaultTeamKey: process.env.LINEAR_DEFAULT_TEAM_KEY,
    };
  }

  if (backendType === "trello") {
    const apiKey = process.env.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY;
    trelloConfig = {
      apiKey,
      apiToken: process.env.TRELLO_API_TOKEN!,
      defaultBoardId: process.env.TRELLO_DEFAULT_BOARD_ID,
      defaultListName: process.env.TRELLO_DEFAULT_LIST_NAME,
    };
  }

  if (backendType === "azure-devops") {
    azureDevOpsConfig = {
      organization: process.env.AZURE_DEVOPS_ORG!,
      pat: process.env.AZURE_DEVOPS_PAT!,
      defaultProject: process.env.AZURE_DEVOPS_PROJECT!,
    };
  }

  if (backendType === "asana") {
    asanaConfig = {
      apiToken: process.env.ASANA_API_TOKEN!,
      defaultProjectGid: process.env.ASANA_DEFAULT_PROJECT_GID,
    };
  }

  if (backendType === "github") {
    const { owner, repo, repository } = parseGitHubRepo(
      process.env.GITHUB_REPO!,
      process.env.GITHUB_OWNER,
    );

    githubConfig = {
      token: process.env.GITHUB_TOKEN!,
      owner,
      repo,
      repository,
    };
  }

  if (backendType === "gitlab") {
    gitlabConfig = {
      token: process.env.GITLAB_TOKEN!,
      projectPath: parseGitLabProject(process.env.GITLAB_PROJECT!),
      baseUrl: sanitizeGitlabBaseUrl(process.env.GITLAB_BASE_URL),
    };
  }

  return {
    backend: backendConfig,
    verbose,
    jira: jiraConfig,
    linear: linearConfig,
    trello: trelloConfig,
    azureDevOps: azureDevOpsConfig,
    asana: asanaConfig,
    github: githubConfig,
    gitlab: gitlabConfig,
  };
}

export interface LoadTrackerConfigOptions {
  /**
   * Also load the DevIntern workspace `.env` as a fallback and merge a plain
   * project `.env` beneath `{configDirName}/.env`. Enabled by the `devpm` CLI;
   * desktop hosts leave it off to keep project-scoped semantics.
   */
  workspaceEnvFallback?: boolean;
}

/**
 * Load tracker configuration from a project config directory.
 *
 * Reads `{configDirName}/.env` first, then validates backend-specific required vars.
 *
 * @param configDirName - Config folder name (e.g. `.devintern-pm`).
 * @param baseDir - Directory to start the upward search from (defaults to cwd).
 * @param options - Optional env-layer behavior (see {@link LoadTrackerConfigOptions}).
 * @returns Fully resolved {@link TrackerConfig} for the selected task tracker.
 * @throws When required environment variables for the chosen backend are missing or invalid.
 */
export async function loadTrackerConfig(
  configDirName: string,
  baseDir?: string,
  options: LoadTrackerConfigOptions = {},
): Promise<TrackerConfig> {
  await loadTrackerEnv(
    configDirName,
    baseDir ?? process.cwd(),
    options.workspaceEnvFallback ?? false,
  );
  return parseTrackerConfigFromEnv();
}
