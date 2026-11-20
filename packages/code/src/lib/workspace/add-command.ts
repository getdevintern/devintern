/**
 * `devintern worker add` — enqueue a one-off task against a workspace repo.
 *
 * Materializes the caller's title/body as a local markdown task file, then
 * inserts a durable row into the workspace DB so the running worker picks it
 * up on its next poll and runs it through the normal pipeline (checkout,
 * agent, PR). No tracker ticket is required, and the repo is named explicitly
 * so `[[routing.rules]]` are not consulted.
 *
 * Non-interactive by default: returns after enqueue. `--wait` blocks until
 * the run settles and exits with its success/failure status (or
 * {@link WAIT_CANCELLED_EXIT_CODE} when the row is cancelled first); `--json` emits a
 * single machine-readable object on stdout (human diagnostics go to stderr).
 */

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import { listHarnesses } from "@devintern/agent-harness";
import { checkLicense } from "@devintern/license-check";

import { LockManager } from "../lock-manager";
import type { LockProbes, PidLiveness } from "../lock-manager";
import { readWorkerHarnessPause } from "../observability/harness-pause";
import type { WorkerHarnessPause } from "../observability/harness-pause";
import { loadSupabaseConfig } from "../cli/bootstrap";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { loadWorkspaceConfig, resolveCredentialTeam } from "./config";
import { InjectedTaskStore } from "../state/injected-tasks";
import type { InjectedTask } from "../state/injected-tasks";
import { applyWorkspaceProcessEnv, repoGitHubSlug } from "./env";
import {
  enqueueInjectedTask,
  InjectedTaskDependencyError,
  MAX_INJECTED_BODY_CHARS,
} from "./injected-enqueue";
import { resolveDependencyMode } from "../dependencies/gate";
import type { DependencyMode } from "../dependencies/gate";
import { describeCancellation } from "./injected-cancel";
import {
  injectedChildStillRunningMessage,
  interruptedChildStillRunning,
} from "./injected-recovery";
import {
  injectedTasksDir,
  resolveWorkspaceDir,
  workspaceCodeStateDir,
  workspaceConfigPath,
  workspaceDbPath,
  workspaceEnvPath,
  workspaceStateDir,
  readWorkerStartMarker,
} from "./paths";
import type { WorkerStartMarker } from "./paths";
import { parseWorkerAddArgs, workerAddUsage } from "./add-args";
import type { AddOptions } from "./add-args";

export { parseWorkerAddArgs } from "./add-args";
export type { AddOptions, ParsedAddArgs } from "./add-args";

/**
 * Exit code of `worker add --wait` when the task was cancelled before it ran
 * (`worker cancel` or the dashboard), distinct from a pipeline failure (1).
 */
export const WAIT_CANCELLED_EXIT_CODE = 3;

/** How often `--wait` re-reads the task row. */
const WAIT_POLL_INTERVAL_MS = 1_000;

/**
 * Default `--wait` deadline (`--wait-timeout`), in seconds.
 *
 * A settled row and a disappeared worker are the fast exits, but a live worker
 * can keep deferring a row forever — a usage-limit pause or a permanently
 * saturated repo requeues the task every tick without progress. The deadline
 * bounds `--wait` so it cannot hang indefinitely; `--wait-timeout 0` opts back
 * into waiting without a limit.
 */
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 6 * 60 * 60;

/**
 * How long `--wait` tolerates a missing worker for an already-claimed task.
 *
 * A claimed (`running`) row is mid-run, so the worker may have just been
 * restarted and startup recovery can auto-resume it. A worker that never
 * returns (crash without a restart, or a permanently stopped daemon) must
 * still fail in bounded time instead of waiting out the six-hour overall
 * deadline.
 */
export const WORKER_RESTART_GRACE_MS = 5 * 60 * 1_000;

/** Printed instead of "No worker is running" when the worker lock cannot be verified. */
const UNVERIFIED_WORKER_NOTICE =
  "Could not verify the worker from this sandbox; the task is queued durably.";

export interface WorkerAddOptions {
  /** Human-readable status sink (defaults to stdout). */
  log?: (message: string) => void;
  /** Failure sink (defaults to stderr). */
  error?: (message: string) => void;
  /** Reads stdin for `--body-file -`; injectable for tests. */
  readStdin?: () => string;
  /** Override {@link WORKER_RESTART_GRACE_MS}; injectable for tests. */
  restartGraceMs?: number;
  /** Override how often `--wait` re-reads the task row; injectable for tests. */
  waitPollIntervalMs?: number;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function displayPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

type BodyResolution = { ok: true; body: string } | { ok: false };
type RepoResolution = { ok: true; repo: RepoConfig } | { ok: false; code: number };

/** Resolve the target repo, or explain how to fix an unknown/ambiguous name. */
function resolveTargetRepo(
  config: WorkspaceConfig,
  requested: string | undefined,
  error: (message: string) => void,
): RepoResolution {
  const names = config.repos.map((repo) => repo.name);
  if (requested) {
    const repo = config.repos.find((candidate) => candidate.name === requested);
    if (repo) return { ok: true, repo };
    error(`❌ Unknown repo "${requested}".`);
    error(`   Valid repos: ${names.join(", ")}`);
    return { ok: false, code: 1 };
  }
  const [onlyRepo] = config.repos;
  if (config.repos.length === 1 && onlyRepo) {
    return { ok: true, repo: onlyRepo };
  }
  error("❌ --repo is required because this workspace has multiple repos.");
  error(`   Valid repos: ${names.join(", ")}`);
  return { ok: false, code: 1 };
}

/** Read and validate the task body (inline, file, or stdin). */
function resolveInjectedBody(
  add: AddOptions,
  options: WorkerAddOptions,
  error: (message: string) => void,
): BodyResolution {
  let body = add.body ?? "";
  if (add.bodyFile !== undefined) {
    try {
      body =
        add.bodyFile === "-"
          ? (options.readStdin ?? readStdin)()
          : readFileSync(add.bodyFile, "utf8");
    } catch (readError) {
      error(`❌ Could not read --body-file ${add.bodyFile}: ${(readError as Error).message}`);
      return { ok: false };
    }
  }
  if (body.length > MAX_INJECTED_BODY_CHARS) {
    error(`❌ Body is too large (${body.length} chars; maximum ${MAX_INJECTED_BODY_CHARS}).`);
    error("   Move long context into the repo or link it from the title.");
    return { ok: false };
  }
  return { ok: true, body };
}

/**
 * Enforce the same automation entitlement the worker daemon requires, and
 * report the outcome with the daemon's wording.
 */
async function checkAutomationAccess(
  selectedDir: string,
  log: (message: string) => void,
  error: (message: string) => void,
): Promise<boolean> {
  applyWorkspaceProcessEnv(selectedDir);
  const licenseResult = await checkLicense({
    productKey: "devintern/code",
    supabaseConfig: loadSupabaseConfig(workspaceCodeStateDir(selectedDir)),
    requireAutomation: true,
    allowTrial: true,
  });
  if (!licenseResult.valid) {
    error("❌ License check failed");
    error(`   ${licenseResult.message}`);
    return false;
  }
  if (licenseResult.source === "grace") log(`⚠️  ${licenseResult.message}`);
  else if (licenseResult.source === "trial") log(`⏳ ${licenseResult.message}`);
  else if (licenseResult.source === "license-key" || licenseResult.source === "entitlement") {
    log(`✅ ${licenseResult.message}`);
  }
  return true;
}

/**
 * Enqueue a one-off task for a workspace repo.
 *
 * @returns Process exit code (0 on enqueue, or the run's status with `--wait`).
 */
export async function runWorkerAdd(
  args: string[],
  options: WorkerAddOptions = {},
): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const error = options.error ?? ((message: string) => console.error(message));

  const parsed = parseWorkerAddArgs(args);
  if (parsed.kind === "help") {
    log(workerAddUsage());
    return 0;
  }
  if (parsed.kind === "error") {
    error(`❌ ${parsed.message}`);
    error("   Run `devintern worker add --help` for usage.");
    return 1;
  }
  const { options: add } = parsed;

  // With `--json`, stdout is reserved for the single result object: route every
  // human/status diagnostic (license line, "Enqueued…", the `--wait` spinner)
  // to stderr so `devintern worker add … --json | jq .` parses cleanly.
  const status = add.json ? error : log;

  const selectedDir = add.workspacePath
    ? dirname(resolve(add.workspacePath))
    : resolveWorkspaceDir();
  const configPath = add.workspacePath
    ? resolve(add.workspacePath)
    : workspaceConfigPath(selectedDir);
  if (!existsSync(configPath)) {
    error(`❌ No workspace.toml at ${configPath}.`);
    error("   Run `devintern worker scaffold` first, then `devintern worker add-repo`.");
    return 1;
  }

  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig(configPath);
  } catch (loadError) {
    error(`❌ Could not read ${configPath}: ${(loadError as Error).message}`);
    return 1;
  }
  if (config.repos.length === 0) {
    error(`❌ No repos configured in ${configPath}.`);
    error("   Run `devintern worker add-repo` inside a checkout first.");
    return 1;
  }

  // `--resume` re-queues an existing row, so title/body/repo resolution (and
  // their validation) apply only to a new enqueue.
  let target: { repo: RepoConfig; body: string; credentialTeam?: string } | null = null;
  if (!add.resume) {
    const repoResult = resolveTargetRepo(config, add.repo, error);
    if (!repoResult.ok) return repoResult.code;

    // Validated now so a typo or an ambiguous fixed-team setup fails here, not
    // later in the worker after the task was queued.
    const teamResult = resolveCredentialTeam(config, repoResult.repo.name, add.team);
    if (!teamResult.ok) {
      error(`❌ ${capitalize(teamResult.error)}.`);
      if (teamResult.reason === "ambiguous") {
        error("   Pick whose credentials the task uses with --team <name>.");
      }
      return 1;
    }

    const bodyResult = resolveInjectedBody(add, options, error);
    if (!bodyResult.ok) return 1;
    target = {
      repo: repoResult.repo,
      body: bodyResult.body,
      ...(teamResult.team ? { credentialTeam: teamResult.team.name } : {}),
    };
  }

  if (!(await checkAutomationAccess(selectedDir, status, error))) return 1;

  // `"unknown"`: the lock was taken in another PID namespace (this command runs
  // inside a PID-isolated sandbox), so a live worker cannot be ruled out.
  const workerRunning: PidLiveness =
    LockManager.readLockStatus(selectedDir, ".worker.lock", { plainDir: true })?.running ?? false;
  if (workerRunning === false && add.wait) {
    error("❌ --wait needs a running worker, but none is active for this workspace.");
    error("   Start it with `devintern worker`, or drop --wait to enqueue durably.");
    return 1;
  }

  const store = new InjectedTaskStore(workspaceDbPath(selectedDir));
  try {
    const context: TaskContext & { workerRunning: PidLiveness } = {
      store,
      selectedDir,
      workerRunning,
      log,
      error,
      status,
      wait: add.wait,
      json: add.json,
      waitTimeoutSeconds: add.waitTimeoutSeconds,
      restartGraceMs: options.restartGraceMs,
      waitPollIntervalMs: options.waitPollIntervalMs,
      dependencyModeDefault: config.defaults.dependencyMode,
    };
    if (add.resume) {
      return await resumeTask(add.resume, context);
    }
    if (!target) {
      error("❌ Could not resolve the task's repo and body.");
      return 1;
    }
    // `await` is load-bearing: without it the surrounding `finally` would
    // `store.close()` while `reportTask`/`waitForTask` is still polling.
    return await enqueueNewTask(add, target, context);
  } catch (enqueueError) {
    // Filesystem/DB failures (including a sandbox denying writes to the
    // workspace state) must not escape as a minified stack trace: agents parse
    // stderr and the exit code, and the raw Node error is not actionable.
    return reportEnqueueFailure(enqueueError, selectedDir, error);
  } finally {
    store.close();
  }
}

/**
 * Explain why an enqueue could not be written, with the fix for the common
 * permission/sandbox denial.
 *
 * @param cause - Error thrown while writing the prompt file or queue row.
 * @param workspaceDir - Workspace home, for the paths an operator must grant.
 * @param error - Failure sink.
 * @returns Exit code 1.
 */
function reportEnqueueFailure(
  cause: unknown,
  workspaceDir: string,
  error: (message: string) => void,
): number {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  error(`❌ Could not enqueue the task: ${detail}`);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    error("   The workspace state must be writable by this process.");
    error(
      `   Grant write access to ${displayPath(injectedTasksDir(workspaceDir))} and ` +
        `${displayPath(workspaceStateDir(workspaceDir))}`,
    );
    error("   (under a sandbox, add them to AGENT_SANDBOX_WRITABLE_PATHS).");
  }
  return 1;
}

/** Shared sinks + task state threaded through the enqueue/report/wait paths. */
interface TaskContext {
  log: (message: string) => void;
  error: (message: string) => void;
  /** Human/status sink: stderr under `--json`, else stdout. */
  status: (message: string) => void;
  wait: boolean;
  json: boolean;
  /** `--wait` deadline in seconds; `0` = no limit, undefined = the default. */
  waitTimeoutSeconds?: number;
  /** How long `--wait` tolerates a missing worker; defaults to the constant. */
  restartGraceMs?: number;
  /** How often `--wait` re-reads the task row; defaults to the constant. */
  waitPollIntervalMs?: number;
  store: InjectedTaskStore;
  selectedDir: string;
  /** `[defaults].dependency_mode` of the selected workspace. */
  dependencyModeDefault?: DependencyMode;
  /**
   * ISO-8601 end of the earliest usage-limit window when every harness in the
   * worker's chain is limited (set once the task row is known to be pending).
   */
  harnessPausedUntil?: string;
}

/** Create the markdown file + durable row, then optionally wait. */
async function enqueueNewTask(
  add: AddOptions,
  target: { repo: RepoConfig; body: string; credentialTeam?: string },
  ctx: TaskContext & { workerRunning: PidLiveness },
): Promise<number> {
  const { repo, body } = target;
  const { store, selectedDir, workerRunning, log, status } = ctx;
  // Only an active (pending/running) task dedupes; a settled one under the
  // same key is history and a new occurrence is enqueued.
  let enqueued: ReturnType<typeof enqueueInjectedTask>;
  try {
    enqueued = enqueueInjectedTask(store, selectedDir, {
      repo: repo.name,
      ...(add.team ? { team: add.team } : {}),
      title: add.title,
      body,
      idempotencyKey: add.idempotencyKey,
      actor: "local:add",
      after: add.after,
      dependencyMode: resolveDependencyMode({
        override: add.dependencyMode,
        configured: ctx.dependencyModeDefault,
        stackMaintained: repoGitHubSlug(repo) !== undefined,
      }),
    });
  } catch (dependencyError) {
    if (!(dependencyError instanceof InjectedTaskDependencyError)) throw dependencyError;
    ctx.error(`❌ ${dependencyError.message}`);
    ctx.error("   No task was enqueued.");
    return 1;
  }
  const { task, deduplicated, ignoredDependencies } = enqueued;
  if (deduplicated) {
    return await reportTask(task, ctx);
  }
  if (ignoredDependencies.length > 0) {
    status(
      `⚠️  Ignoring 'Depends on:' ${ignoredDependencies.join(", ")}: no ad-hoc task with that key ` +
        "in this workspace (use --after to require one).",
    );
  }
  if (task.dependsOn.length === 0 && add.dependencyMode !== undefined) {
    status(
      `⚠️  ${add.dependencyMode === "stacked" ? "--stack" : "--wait-merge"} has no effect ` +
        "without --after or a 'Depends on:' line.",
    );
  }

  const pause = readHarnessPause(selectedDir);
  if (!add.json) {
    status(`✅ Enqueued ${task.taskKey} for repo "${task.repo}" (task #${task.id}).`);
    if (target.credentialTeam) {
      status(`   Credentials: team "${target.credentialTeam}" (env_file and [teams.env]).`);
    }
    if (task.dependsOn.length > 0) {
      status(
        `   Depends on ${task.dependsOn.join(", ")} (${task.dependencyMode ?? "merged"} mode)` +
          (task.dependencyState ? `; ${task.dependencyState}: ${task.dependencyReason}` : ""),
      );
    }
    if (workerRunning === "unknown") {
      status(`ℹ️  ${UNVERIFIED_WORKER_NOTICE}`);
    } else if (!workerRunning) {
      status("⚠️  No worker is running; the task stays queued until one starts.");
    } else if (!pause) {
      status("   The worker picks it up on its next poll.");
    }
  }
  const paused = warnHarnessPause(pause, ctx);
  if (!add.json) status(`   Prompt: ${displayPath(task.taskFile)}`);

  if (!add.wait) {
    if (add.json) log(JSON.stringify({ ...serialize(task), deduplicated: false, ...paused }));
    return 0;
  }
  return await waitForTask(
    task.id,
    { ...ctx, ...paused, deduplicated: false, taskKey: task.taskKey },
    task,
  );
}

function serialize(
  task: Pick<InjectedTask, "id" | "taskKey" | "repo" | "status"> &
    Partial<
      Pick<InjectedTask, "dependsOn" | "dependencyMode" | "dependencyState" | "dependencyReason">
    >,
): {
  id: number;
  taskKey: string;
  repo: string;
  status: string;
  dependsOn?: string[];
  dependencyMode?: DependencyMode;
  dependencyState?: string;
  dependencyReason?: string;
} {
  const dependent = task.dependsOn !== undefined && task.dependsOn.length > 0;
  return {
    id: task.id,
    taskKey: task.taskKey,
    repo: task.repo,
    status: task.status,
    ...(dependent
      ? {
          dependsOn: task.dependsOn,
          dependencyMode: task.dependencyMode ?? "merged",
          ...(task.status === "pending" && task.dependencyState
            ? { dependencyState: task.dependencyState, dependencyReason: task.dependencyReason }
            : {}),
        }
      : {}),
  };
}

/** Best-effort read of the worker's harness-chain pause; never throws. */
function readHarnessPause(selectedDir: string): WorkerHarnessPause | null {
  try {
    return readWorkerHarnessPause(selectedDir, workspaceDbPath(selectedDir));
  } catch {
    return null;
  }
}

/** Fallback harness suggested when the whole chain is usage-limited. */
const FALLBACK_HARNESS_SUGGESTIONS = ["codex", "claude-code", "opencode"];

/** A registered harness not already in the chain, for the fallback hint. */
function suggestFallbackHarness(chain: readonly string[]): string {
  const candidates = [
    ...FALLBACK_HARNESS_SUGGESTIONS,
    ...listHarnesses().map((harness) => harness.name),
  ];
  return candidates.find((name) => !chain.includes(name)) ?? "codex";
}

/**
 * Warn (on the status sink, so stderr under `--json`) that the pending task
 * cannot start until the earliest usage-limit window of the worker's chain
 * elapses, plus a `--wait` timeout warning when its deadline ends earlier.
 *
 * @returns The `harnessPausedUntil` JSON field, or `{}` when not exhausted.
 */
function warnHarnessPause(
  pause: WorkerHarnessPause | null,
  ctx: TaskContext,
): { harnessPausedUntil?: string } {
  if (!pause) return {};
  const until = new Date(pause.untilMs).toISOString();
  const chain = pause.chain.join(",");
  ctx.status(
    `⏳ Every agent harness in AGENT_HARNESS (${chain}) is usage-limited until ${until}; ` +
      "the worker starts this task after that.",
  );
  const example = [...pause.chain, suggestFallbackHarness(pause.chain)].join(",");
  ctx.status(
    `   Add a fallback harness (e.g. AGENT_HARNESS=${example} in ` +
      `${displayPath(workspaceEnvPath(ctx.selectedDir))}) to keep working through limits.`,
  );
  if (ctx.wait) {
    const timeoutSeconds = ctx.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
    if (timeoutSeconds > 0 && Date.now() + timeoutSeconds * 1000 < pause.untilMs) {
      ctx.status(
        `⚠️  --wait-timeout (${timeoutSeconds}s) ends before that reset; ` +
          "the wait will likely time out before the task can start.",
      );
    }
  }
  return { harnessPausedUntil: until };
}

/**
 * Emit the single result for a settled task: the JSON object under `--json`,
 * otherwise a human success/failure line. Returns the process exit code.
 */
function emitSettled(
  task: Pick<InjectedTask, "id" | "taskKey" | "repo" | "status" | "message"> &
    Partial<Pick<InjectedTask, "cancelledBy" | "cancelReason" | "finishedAt">>,
  deduplicated: boolean,
  ctx: TaskContext,
): number {
  if (task.status === "cancelled") {
    const detail = describeCancellation(task);
    const message = `${task.taskKey} was cancelled${detail ? ` ${detail}` : ""} before it ran`;
    if (ctx.json) {
      ctx.log(JSON.stringify({ ...serialize(task), deduplicated, message }));
    } else {
      ctx.error(`⛔ ${message}`);
    }
    return WAIT_CANCELLED_EXIT_CODE;
  }
  if (ctx.json) {
    ctx.log(
      JSON.stringify({
        ...serialize(task),
        deduplicated,
        ...(task.status === "failed"
          ? { error: task.message ?? "task pipeline did not complete cleanly" }
          : {}),
      }),
    );
  } else if (task.status === "failed") {
    ctx.error(`❌ ${task.taskKey} failed${task.message ? `: ${task.message}` : ""}`);
  } else {
    ctx.log(`✅ ${task.taskKey} finished.`);
  }
  return task.status === "failed" ? 1 : 0;
}

/** Report an existing (idempotent) task, waiting on it when requested. */
async function reportTask(task: InjectedTask, ctx: TaskContext): Promise<number> {
  if (!ctx.json) {
    ctx.status(
      `ℹ️  Idempotency key already used by ${task.taskKey} (task #${task.id}, status: ${task.status}).`,
    );
  }
  // Only a still-pending row is waiting on a harness; a running one started.
  const paused =
    task.status === "pending" ? warnHarnessPause(readHarnessPause(ctx.selectedDir), ctx) : {};
  if (!ctx.wait) {
    if (ctx.json) ctx.log(JSON.stringify({ ...serialize(task), deduplicated: true, ...paused }));
    return 0;
  }
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
    return emitSettled(task, true, ctx);
  }
  return await waitForTask(
    task.id,
    { ...ctx, ...paused, deduplicated: true, taskKey: task.taskKey },
    task,
  );
}

/**
 * Re-queue a settled ad-hoc task by key (`worker add --resume`).
 *
 * The row keeps its `task_key`, so the rerun targets the same
 * `feature/local-<slug>` branch the interrupted attempt recorded and session
 * pickup can hand the prior report to the next agent. An already-active row is
 * reported instead of queued twice.
 */
async function resumeTask(
  taskKey: string,
  ctx: TaskContext & { workerRunning: PidLiveness },
): Promise<number> {
  const { store, workerRunning } = ctx;
  const task = store.getByTaskKey(taskKey);
  if (!task) {
    ctx.error(`❌ No ad-hoc task "${taskKey}" in this workspace.`);
    ctx.error("   Enqueue it with `devintern worker add --title ...`.");
    return 1;
  }
  if (task.status === "pending" || task.status === "running") {
    ctx.status(`ℹ️  ${taskKey} is already ${task.status} (task #${task.id}); not re-queued.`);
    const paused =
      task.status === "pending" ? warnHarnessPause(readHarnessPause(ctx.selectedDir), ctx) : {};
    if (!ctx.wait) {
      if (ctx.json) ctx.log(JSON.stringify({ ...serialize(task), deduplicated: true, ...paused }));
      return 0;
    }
    return await waitForTask(task.id, { ...ctx, ...paused, deduplicated: true, taskKey }, task);
  }
  // A cancelled row was withdrawn on purpose; restarting it is not supported.
  if (task.status === "cancelled") {
    const detail = describeCancellation(task);
    ctx.error(
      `❌ ${taskKey} was cancelled${detail ? ` ${detail}` : ""}; a cancelled task cannot be resumed.`,
    );
    ctx.error("   Enqueue it again with `devintern worker add --title ...`.");
    return 1;
  }

  // A hard-killed worker's detached child may still be running this attempt in
  // the same worktree. Re-queueing would force-remove that worktree underneath
  // it, so refuse until the operator confirms the process is gone.
  if (interruptedChildStillRunning(task)) {
    ctx.error(`❌ ${injectedChildStillRunningMessage(taskKey, task.childPid!)}`);
    return 1;
  }

  const revived = store.requeueSettled(taskKey);
  if (!revived) {
    ctx.error(`❌ ${taskKey} could not be re-queued; it moved on. Reload and try again.`);
    return 1;
  }
  const pause = readHarnessPause(ctx.selectedDir);
  if (!ctx.json) {
    ctx.status(`♻️  Re-queued ${revived.taskKey} (task #${revived.id}, repo "${revived.repo}").`);
    if (workerRunning === "unknown") {
      ctx.status(`ℹ️  ${UNVERIFIED_WORKER_NOTICE}`);
    } else if (!workerRunning) {
      ctx.status("⚠️  No worker is running; the task stays queued until one starts.");
    } else if (!pause) {
      ctx.status(
        "   The worker resumes it on its next poll (same branch when the prior attempt left one).",
      );
    }
  }
  const paused = warnHarnessPause(pause, ctx);
  if (!ctx.wait) {
    if (ctx.json)
      ctx.log(JSON.stringify({ ...serialize(revived), deduplicated: false, ...paused }));
    return 0;
  }
  return await waitForTask(
    revived.id,
    { ...ctx, ...paused, deduplicated: false, taskKey },
    revived,
  );
}

/**
 * Emit the terminal result for a `--wait` failure that never observed a settled
 * row (timeout, worker stopped, or an inconclusive pruned row). Under `--json`
 * stdout still carries exactly one object — the documented `… | jq .` contract
 * holds on failures too — with `status: "failed"`; the human diagnostics stay
 * on stderr. Returns the failure exit code.
 */
function failWait(
  ctx: TaskContext & { deduplicated: boolean; taskKey: string },
  result: { id: number; repo?: string; error: string },
  errorLines: readonly string[],
): number {
  for (const line of errorLines) {
    ctx.error(line);
  }
  if (ctx.json) {
    ctx.log(
      JSON.stringify({
        id: result.id,
        taskKey: ctx.taskKey,
        repo: result.repo ?? "",
        status: "failed",
        deduplicated: ctx.deduplicated,
        error: result.error,
        ...(ctx.harnessPausedUntil ? { harnessPausedUntil: ctx.harnessPausedUntil } : {}),
      }),
    );
  }
  return 1;
}

/**
 * Whether the `.worker.starting` marker proves a replacement worker is
 * starting. Only a marker written after the task was claimed can belong to the
 * replacement (an older one is the dead worker's, and its pid may be recycled).
 * The pid is probed namespace-aware via {@link LockManager.probeLiveness}: a
 * marker from another PID namespace cannot be probed (its pid may collide with
 * an unrelated local process), so it counts only while `startedAt` is within
 * `LOCK_HEARTBEAT_STALE_MS`. The marker is never refreshed, so after that
 * window the normal restart grace takes over and still bounds `--wait`.
 */
export function isReplacementWorkerStarting(
  marker: WorkerStartMarker | null,
  taskStartedAt: number | undefined,
  probes: LockProbes = {},
): boolean {
  if (marker === null) return false;
  if (taskStartedAt !== undefined && marker.startedAt < taskStartedAt) return false;
  return (
    LockManager.probeLiveness(marker.pid, marker.pidNamespace, marker.startedAt, probes) !== false
  );
}

/**
 * Poll a task row until it settles and emit exactly one result. Fails fast when
 * the worker disappears, and again when the `--wait-timeout` deadline elapses
 * with the row still unsettled, so `--wait` cannot hang forever. The interim
 * "pending" JSON is intentionally not emitted: with `--wait --json` stdout
 * carries a single object describing the final state (including these
 * failures, which are reported as a terminal `status: "failed"` object).
 */
async function waitForTask(
  id: number,
  ctx: TaskContext & { deduplicated: boolean; taskKey: string },
  initialTask: InjectedTask,
): Promise<number> {
  ctx.status(`⏳ Waiting for task #${id} to finish (Ctrl-C to detach)...`);
  const timeoutSeconds = ctx.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1_000 : Infinity;
  const restartGraceMs = ctx.restartGraceMs ?? WORKER_RESTART_GRACE_MS;
  const pollIntervalMs = ctx.waitPollIntervalMs ?? WAIT_POLL_INTERVAL_MS;
  let workerGapSince: number | null = null;
  for (;;) {
    const task = ctx.store.getById(id);
    if (!task) {
      return reportPrunedTask(id, ctx, initialTask.repo);
    }
    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
      return emitSettled(task, ctx.deduplicated, ctx);
    }
    if (Date.now() >= deadline) {
      return failWait(
        ctx,
        {
          id,
          repo: task.repo,
          error: `Timed out after ${timeoutSeconds}s waiting for task #${id} (still ${task.status}).`,
        },
        [
          `❌ Timed out after ${timeoutSeconds}s waiting for task #${id} (still ${task.status}).`,
          "   It remains queued/running; check the worker dashboard, or raise --wait-timeout (0 disables it).",
        ],
      );
    }
    // An unverifiable lock (another PID namespace, i.e. this waiter runs in a
    // sandbox) counts as alive: giving up would abandon a live worker's task.
    // It stays "unknown" only while the worker refreshes its lock heartbeat; a
    // dead worker's lock turns `false` after LOCK_HEARTBEAT_STALE_MS, so the
    // restart-grace failure below still fires.
    const workerRunning =
      LockManager.readLockStatus(ctx.selectedDir, ".worker.lock", { plainDir: true })?.running ??
      false;
    if (workerRunning !== false) {
      // A replacement worker came back within the grace: a later restart gets
      // its own grace window rather than inheriting an old one.
      workerGapSince = null;
    } else {
      const now = Date.now();
      // The replacement worker writes this marker before its slow pre-lock
      // startup (orphan recovery, worktree sweep, push probes), so a live
      // replacement is evidence the worker is coming back even while the lock
      // is still absent. Only a marker written after this task was claimed can
      // belong to the replacement; an older marker is from the dead worker and
      // a recycled pid must not be mistaken for a new process.
      const startingMarker = readWorkerStartMarker(ctx.selectedDir);
      const replacementStarting = isReplacementWorkerStarting(startingMarker, task.startedAt);
      if (replacementStarting) {
        // Restart grace measures from evidence of a new worker, not from the
        // lock disappearing while that process is still in startup.
        workerGapSince = now;
      } else if (workerGapSince === null) {
        workerGapSince = now;
        if (task.status === "running") {
          ctx.status(
            `ℹ️  No worker is running; task #${id} is still running and may auto-resume when ` +
              "the worker restarts. Still waiting within the restart grace period.",
          );
        }
      }
      if (!replacementStarting && now - workerGapSince >= restartGraceMs) {
        const graceSeconds = Math.max(1, Math.round(restartGraceMs / 1_000));
        const error =
          `The worker stopped and did not restart within ${graceSeconds}s while task #${id} ` +
          "was running.";
        return failWait(ctx, { id, repo: task.repo, error }, [
          `❌ ${error}`,
          "   Start the worker again to auto-resume the task, or inspect the dashboard run history.",
        ]);
      }
      if (task.status !== "running" && !replacementStarting) {
        // A `pending` row has nobody to claim it, so fail fast as before. While
        // a replacement is starting it will be claimed, so it waits through the
        // same bounded grace instead of reporting a transient restart failure.
        return failWait(
          ctx,
          { id, repo: task.repo, error: "The worker stopped before the task finished." },
          [
            "❌ The worker stopped before the task finished; it remains queued/failed.",
            "   Start the worker again and inspect the dashboard run history.",
          ],
        );
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
}

/**
 * Report a task whose injected row was pruned by the worker's retention sweep
 * before `--wait` observed its terminal status.
 *
 * `pruneSettled` retains each row's outcome under its immutable queue ID.
 * This also keeps a later task with the same key from changing this result.
 */
function reportPrunedTask(
  id: number,
  ctx: TaskContext & { deduplicated: boolean; taskKey: string },
  repo: string,
): number {
  const outcome = ctx.store.getPrunedOutcome(id);
  if (!outcome || outcome.repo !== repo) {
    return failWait(ctx, { id, error: `Injected task #${id} disappeared while waiting.` }, [
      `❌ Injected task #${id} disappeared while waiting.`,
    ]);
  }
  const settled = {
    id,
    taskKey: ctx.taskKey,
    repo: outcome.repo,
    status: outcome.status,
    message: outcome.message,
  };
  if (!ctx.json) {
    ctx.status(`ℹ️  Injected task #${id} was pruned after it settled; reporting its outcome.`);
  }
  return emitSettled(settled, ctx.deduplicated, ctx);
}

/** Read all of stdin (used by `--body-file -`). */
function readStdin(): string {
  return readFileSync(0, "utf8");
}
