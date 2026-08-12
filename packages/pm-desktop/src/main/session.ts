/**
 * Current project session for the main process.
 *
 * The app operates on a user-chosen project directory (same mental model as
 * the CLI: credentials live in `<project>/.devintern-pm/.env`). Nothing uses
 * `process.chdir` — the project dir is threaded through the `baseDir`
 * parameters on pm's config loaders.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { listInstalledHarnesses } from "@devintern/agent-harness";
import { findConfigDir } from "@devintern/utils";
import { getTrackerDisplayName } from "@devintern/task-trackers";
import type { ConfiguredTracker } from "@devintern/task-trackers";
import { createEngine, DEFAULT_ISSUE_TYPES } from "@getdevintern/pm/engine";
import type { PmEngine } from "@getdevintern/pm/engine";
import { loadConfig, migrateLegacyConfigDir } from "@getdevintern/pm/config";
import type { Config } from "@getdevintern/pm/config";
import type { AvailableHarness, ProjectStatus } from "../shared/ipc-contract.ts";
import { toProjectBindingInfo } from "../shared/project-binding.ts";
import type { ProjectGitSyncStatus } from "../shared/project-git-sync.ts";
import { authenticatedGitExec } from "./git-auth.ts";
import { detectGitHubRemoteSlug } from "./detect-github-remote.ts";
import { noteSuccessfulFetch } from "./managed-clone.ts";
import { ensureUnmanagedBinding, findBindingByLocalPath } from "./project-bindings.ts";
import { syncProjectFromRemote } from "./git-sync.ts";
import type { GitExec } from "./git-sync.ts";
import {
  listConfiguredTrackersForProject,
  persistActiveHarness,
  persistActiveProject,
  persistActiveTracker,
  readProjectEnv,
} from "./project-env.ts";

/** Installed harnesses for the switcher, always including the active one. */
function availableHarnessesForStatus(
  currentName: string,
  currentDisplayName: string,
): AvailableHarness[] {
  const installed = listInstalledHarnesses({ currentHarnessName: currentName }).map((h) => ({
    name: h.name,
    displayName: h.displayName,
  }));
  if (!installed.some((h) => h.name === currentName)) {
    installed.unshift({ name: currentName, displayName: currentDisplayName });
  }
  return installed;
}

export interface Session {
  projectDir: string;
  config: Config;
  engine: PmEngine;
}

let current: Session | null = null;
/** Last project directory chosen in the UI — kept even when config load fails. */
let lastProjectDir: string | null = null;
/** Last git sync snapshot — reused across harness/tracker switches (no re-fetch). */
let lastGitSync: ProjectGitSyncStatus | undefined;
/** In-flight agent IPC request ids (generate / edit / decompose / create / create-subtasks). */
const activeAgentRequestIds = new Set<string>();
/**
 * Held across harness/tracker/project-key persist + reload so an agent IPC
 * cannot start after .env was rewritten but before the new session is ready.
 * Also held for {@link updateProjectFromRemote} sync+reload and open-path
 * fetch/merge + loadConfig/createEngine.
 */
let contextSwitchInFlight = false;
/** Git runner for project sync — overridable in tests to avoid real network. */
let sessionGitExec: GitExec = authenticatedGitExec;

/**
 * Test-only: override the git runner used by attachGitSync / Update.
 * Pass `undefined` to restore {@link authenticatedGitExec}.
 */
export function setSessionGitExecForTests(exec: GitExec | undefined): void {
  sessionGitExec = exec ?? authenticatedGitExec;
}

export function getSession(): Session | null {
  return current;
}

export function requireSession(): Session {
  if (!current) {
    throw new Error("No project selected. Choose a project directory first.");
  }
  return current;
}

/** Project dir for switch/reload paths that must work even when config failed. */
export function requireProjectDir(): string {
  if (current) return current.projectDir;
  if (lastProjectDir) return lastProjectDir;
  throw new Error("No project selected. Choose a project directory first.");
}

/**
 * Unload the in-memory session so requireSession / requireProjectDir cannot
 * target a removed checkout after Remove project.
 */
export function clearSession(): void {
  current = null;
  lastProjectDir = null;
  lastGitSync = undefined;
}

/** Clear the live session when it still points at `projectDir`. */
export function clearSessionIfProjectDir(projectDir: string): void {
  const resolved = resolve(projectDir);
  if (current && resolve(current.projectDir) === resolved) {
    clearSession();
    return;
  }
  if (lastProjectDir && resolve(lastProjectDir) === resolved) {
    clearSession();
  }
}

/** Mark an agent IPC call as in flight (paired with {@link endAgentRequest}). */
export function beginAgentRequest(requestId: string): void {
  if (contextSwitchInFlight) {
    throw new Error("Unavailable while switching project context");
  }
  activeAgentRequestIds.add(requestId);
}

/** Clear an agent IPC call when it settles (success or failure). */
export function endAgentRequest(requestId: string): void {
  activeAgentRequestIds.delete(requestId);
}

export function hasActiveAgentRequest(): boolean {
  return activeAgentRequestIds.size > 0;
}

/**
 * Reject session teardown / context switches while any agent/tracker call is
 * still using the session engine — mirrors the renderer `isBusy` policy
 * (generating / editing / decomposing / creating / creating-subtasks) for
 * Change Project, harness, tracker, and project-key switches.
 */
function assertNoActiveAgentRequest(): void {
  if (activeAgentRequestIds.size > 0) {
    throw new Error("Unavailable while an agent is running");
  }
}

function beginContextSwitch(): void {
  assertNoActiveAgentRequest();
  if (contextSwitchInFlight) {
    throw new Error("Unavailable while switching project context");
  }
  contextSwitchInFlight = true;
}

function endContextSwitch(): void {
  contextSwitchInFlight = false;
}

/**
 * Hold the context-switch mutex for teardown that must not race agent IPC
 * (e.g. Remove project deleting a managed checkout).
 */
export async function withContextSwitchMutex<T>(fn: () => Promise<T>): Promise<T> {
  beginContextSwitch();
  try {
    return await fn();
  } finally {
    endContextSwitch();
  }
}

/**
 * Persist a context change then reload the session under a mutex so agent
 * handlers cannot interleave after .env is rewritten.
 *
 * Exported for tests that assert the other half of the mutex contract
 * (beginAgentRequest rejects while a switch is in flight).
 */
export async function switchContext(
  persist: (projectDir: string) => Promise<void>,
): Promise<ProjectStatus> {
  beginContextSwitch();
  try {
    const projectDir = requireProjectDir();
    await persist(projectDir);
    return await loadProject(projectDir, { underContextSwitch: true });
  } finally {
    endContextSwitch();
  }
}

/**
 * Resolve the pm package's bundled prompts/ directory.
 *
 * The engine gets bundled into out/main by electron-vite, so its own
 * module-relative default would point at the wrong place.
 */
function resolvePromptsDir(): string {
  const require = createRequire(import.meta.url);
  const pmPackageJson = require.resolve("@getdevintern/pm/package.json");
  return join(dirname(pmPackageJson), "prompts");
}

/** True when the project (or an ancestor) already has a `.devintern-code` directory. */
export async function detectCodeConfig(projectDir: string): Promise<boolean> {
  return findConfigDir({ configDirName: ".devintern-code", startDir: projectDir }) !== null;
}

/**
 * True when the project (or an ancestor within the git tree) has a `.devintern-pm`
 * config directory.
 *
 * Unlike `findEnvFile`, this does **not** fall through to a plain project `.env` —
 * a root `.env` alone is not PM setup.
 */
export function detectPmConfig(projectDir: string): boolean {
  return findConfigDir({ configDirName: ".devintern-pm", startDir: projectDir }) !== null;
}

/**
 * True when `projectDir` (or an ancestor) is inside a git working tree.
 *
 * Walks parents looking for a `.git` entry (directory or worktree gitfile).
 * Does not require the `git` binary — suitable for Electron main on all OSes.
 * Nested packages in a monorepo count as git-connected via the repo root.
 */
export function detectGitRepository(projectDir: string): boolean {
  let currentDir = resolve(projectDir);
  while (true) {
    if (existsSync(join(currentDir, ".git"))) {
      return true;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return false;
    }
    currentDir = parentDir;
  }
}

async function resolveConfiguredTrackers(projectDir: string): Promise<ConfiguredTracker[]> {
  try {
    return await listConfiguredTrackersForProject(projectDir);
  } catch {
    return [];
  }
}

async function resolveActiveTrackerId(projectDir: string): Promise<string | undefined> {
  try {
    const { env } = await readProjectEnv(projectDir);
    return (env.TASK_TRACKER || "jira").toLowerCase();
  } catch {
    return undefined;
  }
}

export interface LoadProjectOptions {
  /**
   * When true, allow reload while {@link contextSwitchInFlight} is held —
   * only for the persist→reload path inside {@link switchContext}.
   */
  underContextSwitch?: boolean;
  /**
   * Skip fetch/pull and keep {@link lastGitSync} (or a caller-provided snapshot).
   * Used after {@link updateProjectFromRemote} already synced.
   */
  skipGitSync?: boolean;
  /** When skipGitSync, attach this snapshot instead of {@link lastGitSync}. */
  gitSync?: ProjectGitSyncStatus;
}

async function attachGitSync(
  status: ProjectStatus,
  projectDir: string,
  options?: LoadProjectOptions,
): Promise<ProjectStatus> {
  if (!status.isGitRepository) {
    lastGitSync = undefined;
    return status;
  }
  // Tracker/harness/project-key switches reload the session — don't re-fetch.
  if (options?.underContextSwitch || options?.skipGitSync) {
    const freshSync = options.gitSync;
    status.gitSync = freshSync ?? lastGitSync;
    if (freshSync) lastGitSync = freshSync;
    // Lookup-only: do not run `git remote` (tests and switch paths expect no git).
    await attachProjectBinding(status, projectDir, { detectRemote: false });
    // Note lastFetch only when this invocation supplied a real sync snapshot
    // (open/Update). Reusing lastGitSync must not bump the timestamp.
    if (freshSync) {
      await maybeNoteFetch(status);
    }
    return status;
  }
  try {
    // Fallback sync for callers that did not pre-sync (should be rare — open
    // and Update sync first). sessionGitExec times out hung remotes.
    status.gitSync = await syncProjectFromRemote(projectDir, sessionGitExec, { pull: true });
  } catch (error) {
    status.gitSync = {
      kind: "error",
      softDirty: false,
      message: error instanceof Error ? error.message : String(error),
    } satisfies ProjectGitSyncStatus;
  }
  lastGitSync = status.gitSync;
  await attachProjectBinding(status, projectDir);
  await maybeNoteFetch(status);
  return status;
}

function fetchSucceeded(sync: ProjectGitSyncStatus | undefined): boolean {
  // Only advance lastFetch when a fetch actually ran (not pre-fetch hard-dirty skip).
  return sync?.fetched === true;
}

async function maybeNoteFetch(status: ProjectStatus): Promise<void> {
  if (!fetchSucceeded(status.gitSync)) return;
  try {
    await noteSuccessfulFetch(status.projectDir);
    // Refresh binding snapshot so lastFetch is visible immediately.
    const binding = await findBindingByLocalPath(status.projectDir);
    if (binding) {
      status.projectBinding = toProjectBindingInfo(binding);
    }
  } catch {
    // Settings / binding persistence must not block project open.
  }
}

/**
 * Attach sidebar binding info. Managed clones already have a binding; folder
 * opens get an unmanaged binding (never migrated into userData/projects).
 */
async function attachProjectBinding(
  status: ProjectStatus,
  projectDir: string,
  options?: { detectRemote?: boolean },
): Promise<void> {
  const detectRemote = options?.detectRemote !== false;
  try {
    let binding = await findBindingByLocalPath(projectDir);
    if (detectRemote && !binding && status.isGitRepository) {
      const remote = await detectGitHubRemoteSlug(projectDir, sessionGitExec);
      binding = await ensureUnmanagedBinding({ localPath: projectDir, remote });
    } else if (detectRemote && binding && !binding.remote && status.isGitRepository) {
      const remote = await detectGitHubRemoteSlug(projectDir, sessionGitExec);
      if (remote) {
        binding = await ensureUnmanagedBinding({ localPath: projectDir, remote });
      }
    }
    if (binding) {
      status.projectBinding = toProjectBindingInfo(binding);
    }
  } catch {
    // Binding persistence must not block project open.
  }
}

/**
 * Load (or reload) the session for a project directory and report its status.
 *
 * Non-git folders are unsuitable: config/engine are not initialized and
 * `configured` stays false even if `.devintern-pm` exists. Git folders without
 * a `.devintern-pm` directory are unconfigured (setup offered) — we do not call
 * `loadConfig`, which would otherwise treat a plain project `.env` and/or stale
 * `process.env` from a previously opened project as a valid session. Config
 * problems inside a real PM config dir are reported in the returned status
 * rather than thrown, so the renderer can guide the user instead of crashing.
 *
 * Git checkouts fetch + ff-only merge on open when clean or PM soft-dirty,
 * **before** loadConfig/createEngine (same sync-then-reload order as Update),
 * under the context-switch mutex so agent IPC cannot start mid-merge.
 * Hard-dirty open skips fetch (behind counts only on Update).
 * The Update control re-runs the same pipeline (including after sync errors).
 */
export async function loadProject(
  projectDir: string,
  options?: LoadProjectOptions,
): Promise<ProjectStatus> {
  // Must run before clearing `current` — choose-project / getProjectStatus
  // rebuild the engine and would orphan in-flight generate/edit/decompose/create.
  assertNoActiveAgentRequest();
  // External reloads (getProjectStatus / initializeProject / choose-project)
  // must not tear down `current` during a harness/tracker/project-key switch.
  if (contextSwitchInFlight && !options?.underContextSwitch) {
    throw new Error("Unavailable while switching project context");
  }
  // Normalize so recent-list / status / settings comparisons stay path-stable.
  projectDir = resolve(projectDir);

  const isGitRepository = detectGitRepository(projectDir);
  // Open-path fetch/merge: hold the same mutex as Update so beginAgentRequest
  // cannot start while the working tree may still be mutating, and so we never
  // publish `current` before sync finishes.
  const ownsOpenSyncMutex =
    isGitRepository && !options?.underContextSwitch && !options?.skipGitSync;
  if (ownsOpenSyncMutex) {
    beginContextSwitch();
  }

  try {
    current = null;
    lastProjectDir = projectDir;

    const status: ProjectStatus = {
      projectDir,
      configured: false,
      isGitRepository,
      hasCodeConfig: await detectCodeConfig(projectDir),
      configuredTrackers: [],
    };

    // Non-git folders are unsuitable: do not init config/engine or expose tracker state.
    if (!isGitRepository) {
      return status;
    }

    // Sync first (open path only), then load config/engine from the post-merge tree.
    let openPathGitSync: ProjectGitSyncStatus | undefined;
    if (ownsOpenSyncMutex) {
      try {
        openPathGitSync = await syncProjectFromRemote(projectDir, sessionGitExec, {
          pull: true,
          // Hard-dirty WIP: skip fetch so open is not blocked up to the sync budget
          // just to populate behind counts (Update still fetches).
          fetchHardDirty: false,
        });
      } catch (error) {
        openPathGitSync = {
          kind: "error",
          softDirty: false,
          message: error instanceof Error ? error.message : String(error),
        } satisfies ProjectGitSyncStatus;
      }
      lastGitSync = openPathGitSync;
    }

    const attachOptions: LoadProjectOptions = ownsOpenSyncMutex
      ? { skipGitSync: true, gitSync: openPathGitSync }
      : (options ?? {});

    // Migrate legacy `.claude-pm` before detecting the PM config directory.
    await migrateLegacyConfigDir(projectDir);

    // No `.devintern-pm` dir → offer setup. Skip loadConfig entirely.
    // Git sync snapshot is still attached (from open-path sync or caller).
    if (!detectPmConfig(projectDir)) {
      return attachGitSync(status, projectDir, attachOptions);
    }

    const configuredTrackers = await resolveConfiguredTrackers(projectDir);
    const activeTrackerId = await resolveActiveTrackerId(projectDir);
    status.configuredTrackers = configuredTrackers;
    status.activeTrackerId = activeTrackerId;
    status.activeTrackerDisplayName = activeTrackerId
      ? getTrackerDisplayName(activeTrackerId)
      : undefined;

    try {
      const config = await loadConfig(projectDir);
      const engine = await createEngine(config, {
        promptsDir: resolvePromptsDir(),
        baseDir: projectDir,
      });
      current = { projectDir, config, engine };

      status.configured = true;
      status.backendName = engine.backendName;
      status.activeTrackerId = config.backend.type;
      status.activeTrackerDisplayName = getTrackerDisplayName(config.backend.type);
      status.activeHarnessName = config.agent.harness.name;
      status.harnessDisplayName = config.agent.harness.displayName;
      status.availableHarnesses = availableHarnessesForStatus(
        config.agent.harness.name,
        config.agent.harness.displayName,
      );
      status.supportsIssueTypes = engine.supportsIssueTypes;
      status.supportsEpicLinking = engine.supportsEpicLinking;
      status.supportsLabels = engine.supportsLabels;
      status.supportsFreeformLabels = engine.supportsFreeformLabels;
      status.supportsAttachments = engine.supportsAttachments;
      status.defaultProjectKey = engine.defaultProjectKey;
      status.supportsProjectSwitch = Boolean(
        configuredTrackers.find((t) => t.id === config.backend.type)?.projectKeyEnv,
      );

      try {
        status.projects = await engine.listProjects();
      } catch (error) {
        status.projects = undefined;
        status.projectsError = error instanceof Error ? error.message : String(error);
      }
      if (engine.supportsIssueTypes) {
        try {
          status.issueTypes = await engine.listIssueTypes(status.defaultProjectKey);
        } catch {
          status.issueTypes = [...DEFAULT_ISSUE_TYPES];
        }
      }
      if (engine.supportsLabels) {
        try {
          const catalog = await engine.listLabels(status.defaultProjectKey);
          status.labels = catalog.labels;
          status.labelsTruncated = catalog.truncated;
        } catch (error) {
          status.labels = [];
          status.labelsTruncated = false;
          status.labelsError = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      status.configError = error instanceof Error ? error.message : String(error);
    }

    return attachGitSync(status, projectDir, attachOptions);
  } finally {
    if (ownsOpenSyncMutex) {
      endContextSwitch();
    }
  }
}

/**
 * Fetch + ff-only update for the current project, then refresh the session.
 * Soft-dirty does not block; hard-dirty skips with a clear message.
 *
 * Holds the same mutex as harness/tracker switches for the whole sync+reload
 * critical section so agent/context IPC cannot interleave while `current` is
 * stale or while loadProject rebuilds the engine.
 */
export async function updateProjectFromRemote(): Promise<ProjectStatus> {
  beginContextSwitch();
  try {
    const projectDir = requireProjectDir();
    const gitSync = await syncProjectFromRemote(projectDir, sessionGitExec, { pull: true });
    // Reload session so engine/config see any pulled files; reuse sync snapshot.
    return await loadProject(projectDir, {
      skipGitSync: true,
      gitSync,
      underContextSwitch: true,
    });
  } finally {
    endContextSwitch();
  }
}

/** Persist `TASK_TRACKER` and reload the session for the new backend. */
export async function switchTracker(trackerId: string): Promise<ProjectStatus> {
  return switchContext(async (projectDir) => {
    await persistActiveTracker(projectDir, trackerId);
  });
}

/** Persist the tracker's project-key env var and reload the session. */
export async function switchProjectKey(projectKey: string): Promise<ProjectStatus> {
  return switchContext(async (projectDir) => {
    const trackerId = getSession()?.config.backend.type;
    await persistActiveProject(projectDir, projectKey, trackerId);
  });
}

/** Persist `AGENT_HARNESS` and reload the session for the new agent. */
export async function switchHarness(harnessName: string): Promise<ProjectStatus> {
  return switchContext(async (projectDir) => {
    await persistActiveHarness(projectDir, harnessName);
  });
}
