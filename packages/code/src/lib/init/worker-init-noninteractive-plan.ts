/**
 * Flags-mode input of the `worker init` steps: the tracker, workspace, and
 * query steps validate every input without touching the filesystem, then the
 * save step writes `workspace.toml` and `.env` atomically under the workspace
 * lock (and puts them back when the checks fail).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";

import { upsertEnvVars } from "@devintern/utils";

import { redactUrlCredentials } from "../observability/dashboard-workspace";
import { trackersSupportingPolling } from "../trackers/capabilities";
import { trackerRequiredEnv } from "../trackers/manager";
import { Utils } from "../utils";
import { gitHubSlugFromRemote, parseWorkspaceConfig } from "../workspace/config";
import type { WorkspaceConfig } from "../workspace/config";
import { parseEnvFile, parseEnvFileContent } from "../workspace/env";
import {
  CONFIG_TEMPLATE,
  ENV_TEMPLATE,
  appendRepoEntry,
  detectCheckoutBranches,
  readRepoEnv,
  repoDefaultProjectKey,
  splitRepoEnv,
  upsertWorkerOperatingPolicy,
  upsertWorkspaceDefaults,
} from "../workspace/init";
import {
  ensureWorkspaceCodeState,
  workspaceConfigPath,
  workspaceEnvPath,
} from "../workspace/paths";
import { TRACKER_SETUP } from "./scaffold";
import { acquireWorkspaceInitLock, errorMessage, writeFileAtomic } from "./worker-init-fs";
import { RECOMMENDED_WORKER_POLICY } from "./worker-init-policy";
import type {
  Env,
  InitErrorCode,
  InitRepo,
  NonInteractiveInitArgs,
  NonInteractiveInitReport,
} from "./worker-init-noninteractive-types";

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
async function detectCwdRepo(cwd: string): Promise<
  | {
      ok: true;
      root: string;
      remote: string;
      slug: string | null;
      /** Branch the checkout is on (`undefined` when detached). */
      branch?: string;
      /** `origin/HEAD`'s branch, else the checked-out branch. */
      defaultBranch?: string;
    }
  | { ok: false; error: string }
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
  const { branch, defaultBranch } = await detectCheckoutBranches(root);
  return {
    ok: true,
    root,
    remote,
    slug: gitHubSlugFromRemote(remote),
    branch,
    defaultBranch,
  };
}

/** Validated inputs and the writes they imply. */
export interface Plan {
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
    branch?: string;
    defaultBranch?: string;
  };
  /** Composed credentials: workspace `.env` < process env < `--env-file`. */
  credentialEnv: Env;
  /** Keys to save to the workspace `.env`. */
  envUpdates: Record<string, string>;
  /** One-line notes for the text output (for example a path made absolute). */
  notes: string[];
  /** Snapshot of workspace.toml when validated (null when absent). */
  configSnapshot: string | null;
  /** Absolute `--env-file` path, when one was given. */
  envFilePath?: string;
  /** Write the recommended worker settings explicitly (the settings step decides). */
  writeRecommendedPolicy: boolean;
}

/** A planning failure: one message and its stable code. */
export interface PlanFailure {
  ok: false;
  error: string;
  code: InitErrorCode;
  tracker?: string;
  missing?: string[];
}

/** Snapshot and parse an existing workspace.toml. */
function readExistingWorkspace(workspaceDir: string):
  | {
      ok: true;
      configSnapshot: string | null;
      existing?: WorkspaceConfig;
    }
  | PlanFailure {
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) return { ok: true, configSnapshot: null };
  let configSnapshot: string;
  try {
    configSnapshot = readFileSync(configPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      code: "workspace_invalid",
      error: `Cannot read ${configPath}: ${errorMessage(error)}`,
    };
  }
  try {
    return { ok: true, configSnapshot, existing: parseWorkspaceConfig(configSnapshot, configPath) };
  } catch (error) {
    return {
      ok: false,
      code: "workspace_invalid",
      error: `Cannot update ${configPath}: ${errorMessage(error)}`,
    };
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
 * Why a query cannot be meant for this tracker, or `undefined`. GitHub search
 * has no `field = value` comparisons and no `ORDER BY`, so a JQL-style query
 * would silently become a free-text search that matches nothing.
 */
export function wrongQueryLanguage(tracker: string, query: string): string | undefined {
  if (tracker !== "github") return undefined;
  const comparison = /(?:^|[\s(])[A-Za-z_][\w."]*\s*(?:!=|=|~|\bin\s*\()/i;
  if (!comparison.test(query) && !/\border\s+by\b/i.test(query)) return undefined;
  return (
    `--task-query "${query}" looks like Jira JQL, but the github tracker uses GitHub issue ` +
    "search qualifiers, for example `is:open label:devintern` or `is:open assignee:@me`."
  );
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

/**
 * The worker daemon (service cwd: the workspace) and each task run (cwd: the
 * repo checkout) would resolve a relative MARKDOWN_TASKS_DIR differently, so
 * save the folder the user means: relative to where this command runs.
 *
 * @returns The `--env-file` values with the folder made absolute.
 */
function absoluteMarkdownDir(
  envFileValues: Record<string, string>,
  credentialEnv: Env,
  ctx: { cwd: string; processEnv: Env },
  notes: string[],
): Record<string, string> {
  const supplied = envFileValues.MARKDOWN_TASKS_DIR || ctx.processEnv.MARKDOWN_TASKS_DIR;
  if (!supplied || isAbsolute(supplied)) return envFileValues;
  const absolute = resolve(ctx.cwd, supplied);
  credentialEnv.MARKDOWN_TASKS_DIR = absolute;
  notes.push(`ℹ️  MARKDOWN_TASKS_DIR=${supplied} saved as the absolute path ${absolute}`);
  return envFileValues.MARKDOWN_TASKS_DIR
    ? { ...envFileValues, MARKDOWN_TASKS_DIR: absolute }
    : envFileValues;
}

/** The `missing_input` failure naming every missing flag and variable. */
function missingInputFailure(tracker: string | undefined, missing: string[]): PlanFailure {
  const markdownDir =
    tracker === "markdown" && missing.includes("MARKDOWN_TASKS_DIR")
      ? " MARKDOWN_TASKS_DIR is the folder that holds the Markdown task files; set it to an " +
        "absolute path, for example MARKDOWN_TASKS_DIR=$PWD/tasks."
      : "";
  return {
    ok: false,
    code: "missing_input",
    missing,
    tracker,
    error:
      `missing: ${missing.join(", ")}. Pass the flags, and set credentials in the ` +
      `environment or in a file passed with --env-file <path> (mode 0600).${markdownDir}`,
  };
}

/** Inputs the tracker and workspace steps validated; the query step completes the plan. */
export interface PlanDraft {
  /** `--tracker`, lowercased (undefined: keep the workspace's). */
  flagTracker?: string;
  envFilePath?: string;
  envFileValues: Record<string, string>;
  configSnapshot: string | null;
  existing?: WorkspaceConfig;
  repo?: Plan["repo"];
}

/** Tracker step: check `--tracker` and read `--env-file`. Touches nothing on disk. */
export function planTracker(
  args: NonInteractiveInitArgs,
  cwd: string,
): { ok: true; draft: PlanDraft } | PlanFailure {
  const supported = trackersSupportingPolling();
  const flagTracker = args.tracker?.trim().toLowerCase();
  if (flagTracker && !supported.includes(flagTracker)) {
    return {
      ok: false,
      code: "unsupported_tracker",
      error: `Unsupported --tracker "${args.tracker}". Supported trackers: ${supported.join(", ")}.`,
    };
  }
  const draft: PlanDraft = { flagTracker, envFileValues: {}, configSnapshot: null };
  if (args.envFile) {
    draft.envFilePath = resolve(cwd, args.envFile);
    const read = readEnvFile(draft.envFilePath);
    if (!read.ok) return { ...read, code: "env_file_unreadable" };
    draft.envFileValues = read.values;
  }
  return { ok: true, draft };
}

/** Workspace step: read the existing workspace.toml and resolve `--repo-from-cwd`. */
export async function planWorkspace(
  args: NonInteractiveInitArgs,
  draft: PlanDraft,
  ctx: { cwd: string; workspaceDir: string },
): Promise<PlanFailure | null> {
  const read = readExistingWorkspace(ctx.workspaceDir);
  if (!read.ok) return read;
  draft.configSnapshot = read.configSnapshot;
  draft.existing = read.existing;
  if (!args.repoFromCwd) return null;
  const detected = await detectCwdRepo(ctx.cwd);
  if (!detected.ok) return { ...detected, code: "not_a_repository" };
  draft.repo = {
    remote: detected.remote,
    slug: detected.slug,
    root: detected.root,
    conflicts: {},
    branch: detected.branch,
    defaultBranch: detected.defaultBranch,
  };
  return null;
}

/**
 * Query step: the query and the credentials it runs with complete the plan
 * (every missing flag and variable is reported at once). Touches nothing on disk.
 */
export function planQuery(
  args: NonInteractiveInitArgs,
  draft: PlanDraft,
  ctx: { cwd: string; processEnv: Env; workspaceDir: string },
): { ok: true; plan: Plan } | PlanFailure {
  const { flagTracker, configSnapshot, existing, repo, envFilePath } = draft;
  let { envFileValues } = draft;
  const tracker = flagTracker ?? existing?.defaults.tracker;
  const taskQuery = args.taskQuery?.trim() || existing?.defaults.taskQuery;
  // Same parser the worker and `worker doctor` use, so all three agree.
  const workspaceEnv = parseEnvFile(workspaceEnvPath(ctx.workspaceDir));
  const credentialEnv: Env = { ...workspaceEnv, ...ctx.processEnv, ...envFileValues };
  if (tracker === "github" && !credentialEnv.GITHUB_REPO && repo?.slug) {
    credentialEnv.GITHUB_REPO = repo.slug;
  }

  const notes: string[] = [];
  if (tracker === "markdown") {
    envFileValues = absoluteMarkdownDir(envFileValues, credentialEnv, ctx, notes);
  }

  const missing = missingInputs(tracker, taskQuery, credentialEnv);
  if (missing.length > 0) return missingInputFailure(tracker, missing);

  const wrongLanguage = wrongQueryLanguage(tracker!, taskQuery!);
  if (wrongLanguage) {
    return { ok: false, code: "invalid_query", tracker, error: wrongLanguage };
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
      writeRecommendedPolicy: false,
      ...(envFilePath ? { envFilePath } : {}),
    },
  };
}

/** workspace.toml text after applying the plan to `current`, and the repo entry it implies. */
export function renderPlannedConfig(
  plan: Plan,
  current: string | null,
): { content: string; repo: InitRepo | null; seededProject?: string } {
  let content = upsertWorkspaceDefaults(current ?? CONFIG_TEMPLATE, {
    tracker: plan.setTracker ? plan.tracker : undefined,
    taskQuery: plan.setTaskQuery ? plan.taskQuery : undefined,
  });
  let repo: InitRepo | null = null;
  let seededProject: string | undefined;
  if (plan.repo) {
    const appended = appendRepoEntry(content, plan.repo.remote, {
      conflicts: plan.repo.conflicts,
      projectKey: plan.repo.projectKey,
      defaultBranch: plan.repo.defaultBranch,
    });
    content = appended.content;
    seededProject = appended.seededProject;
    repo = {
      name: appended.name,
      remote: redactUrlCredentials(plan.repo.remote),
      added: appended.added,
      ...(appended.added && plan.repo.defaultBranch
        ? { defaultBranch: plan.repo.defaultBranch }
        : {}),
      ...(plan.repo.branch ? { branch: plan.repo.branch } : {}),
    };
  }
  if (plan.writeRecommendedPolicy) {
    // Last, exactly where the wizard's settings step writes them.
    content = upsertWorkerOperatingPolicy(content, {
      ...RECOMMENDED_WORKER_POLICY,
      activeWindows: [],
    });
  }
  return { content, repo, seededProject };
}

/** True when applying the plan would change neither workspace.toml nor `.env`. */
export function planChangesNothing(plan: Plan, workspaceDir: string): boolean {
  if (plan.configSnapshot === null) return false;
  if (Object.keys(plan.envUpdates).length > 0) return false;
  if (!existsSync(workspaceEnvPath(workspaceDir))) return false;
  return renderPlannedConfig(plan, plan.configSnapshot).content === plan.configSnapshot;
}

/** What {@link applyPlan} replaced, so a failed run can put it back. */
export interface AppliedWrite {
  path: string;
  /** Content before this run, or null when the file did not exist. */
  previous: string | null;
  written: string;
}

/** Phase 2: write workspace.toml and `.env` under the workspace lock. */
export function applyPlan(
  plan: Plan,
  workspaceDir: string,
):
  | {
      ok: true;
      filesWritten: string[];
      writes: AppliedWrite[];
      repo: NonInteractiveInitReport["repo"];
      seededProject?: string;
    }
  | PlanFailure {
  try {
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      code: "write_failed",
      error: `Cannot create ${workspaceDir}: ${errorMessage(error)}`,
    };
  }
  const lock = acquireWorkspaceInitLock(workspaceDir);
  if (!lock.ok) return { ...lock, code: "workspace_busy" };
  try {
    const configPath = workspaceConfigPath(workspaceDir);
    const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
    if (current !== plan.configSnapshot) {
      return {
        ok: false,
        code: "workspace_busy",
        error: `The workspace is being modified: ${configPath} changed while this command ran. Re-run it.`,
      };
    }

    const { content, repo, seededProject } = renderPlannedConfig(plan, current);
    try {
      parseWorkspaceConfig(content, configPath);
    } catch (error) {
      return {
        ok: false,
        code: "workspace_invalid",
        error: `Refusing to write an invalid ${configPath}: ${errorMessage(error)}`,
      };
    }

    const writes: AppliedWrite[] = [];
    // Credentials first: a config that names a tracker without its
    // credentials is worse than credentials with no config change.
    const envPath = workspaceEnvPath(workspaceDir);
    const envExists = existsSync(envPath);
    if (!envExists || Object.keys(plan.envUpdates).length > 0) {
      const previous = envExists ? readFileSync(envPath, "utf8") : null;
      const written = upsertEnvVars(previous ?? ENV_TEMPLATE, plan.envUpdates);
      writeFileAtomic(envPath, written, 0o600);
      writes.push({ path: envPath, previous, written });
    }
    if (content !== current) {
      writeFileAtomic(configPath, content);
      writes.push({ path: configPath, previous: current, written: content });
    }
    ensureWorkspaceCodeState(workspaceDir);
    return {
      ok: true,
      filesWritten: writes.map((write) => write.path),
      writes,
      repo,
      seededProject,
    };
  } catch (error) {
    return {
      ok: false,
      code: "write_failed",
      error: `Cannot write to ${workspaceDir}: ${errorMessage(error)}`,
    };
  } finally {
    lock.release();
  }
}

/**
 * Put back what {@link applyPlan} wrote, under the workspace lock. A file that
 * changed again since (another process) is left alone and reported.
 *
 * @returns Files that could not be restored, with the reason.
 */
export function rollbackWrites(workspaceDir: string, writes: AppliedWrite[]): string[] {
  if (writes.length === 0) return [];
  const lock = acquireWorkspaceInitLock(workspaceDir);
  if (!lock.ok) return writes.map((write) => `${write.path}: ${lock.error}`);
  const problems: string[] = [];
  try {
    for (const write of [...writes].reverse()) {
      try {
        const now = existsSync(write.path) ? readFileSync(write.path, "utf8") : null;
        if (now !== write.written) {
          problems.push(`${write.path}: changed by another process; left as it is`);
          continue;
        }
        if (write.previous === null) rmSync(write.path, { force: true });
        else writeFileAtomic(write.path, write.previous);
      } catch (error) {
        problems.push(`${write.path}: ${errorMessage(error)}`);
      }
    }
  } finally {
    lock.release();
  }
  return problems;
}
