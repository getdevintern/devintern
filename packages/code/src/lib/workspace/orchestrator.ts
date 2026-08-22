/**
 * Coordinated multi-repo task execution.
 *
 * Orchestration layer on top of the single-repository workflow: one tracker
 * task is planned across several workspace repositories (agent-generated,
 * hint-informed, validated plan), then executed once per planned repository
 * IN DEPENDENCY ORDER by invoking the existing single-repo pipeline (branch,
 * agent, commit, push, PR) in that repository's disposable worktree. No
 * branch/commit/push/PR logic is duplicated here.
 *
 * Durability: every state transition and external side effect is persisted
 * immediately in the {@link CoordinationStore}, keyed by a stable
 * coordination ID. An interrupted run resumes from the database: completed
 * repositories are never re-run, branches derive deterministically from the
 * coordination ID, and PR URLs harvested from the pipeline's own run records
 * are reused instead of creating duplicates.
 *
 * Failure behavior: a failed repository blocks its dependents (recorded as
 * `blocked`, never executed automatically), preserves successful
 * prerequisite work, and leaves the effort resumable (`partial_failure`).
 * Existing PRs are never closed or deleted. Sibling links in PR bodies are
 * reconciled once every PR URL is known; reconciliation failures are
 * recoverable and retryable independently of implementation.
 */

import { Utils } from "../utils";
import type { RunRecord, RunStore } from "../run-recorder";
import type { LockManager } from "../lock-manager";
import { findRepo } from "./config";
import type { RepoConfig, WorkspaceConfig } from "./config";
import type { CoordinationRunStatus, CoordinationStore } from "./coordination";
import { buildRepoEnv } from "./env";
import { coordinationBranchName, generateCoordinationId } from "./plan";
import type { MultiRepoPlan } from "./plan";
import type { PlanningTaskInput, PlannerResult } from "./planner-agent";

/** Structural slice of {@link RepoManager} the orchestrator drives. */
export interface OrchestratorRepoManager {
  ensureBareClone(repo: RepoConfig): Promise<string>;
  fetch(repoName: string): Promise<void>;
  createTaskWorktree(repo: RepoConfig, taskKey: string): Promise<string>;
  removeTaskWorktree(repoName: string, worktreePath: string): Promise<void>;
  /** Absolute path of the repo's bare clone (for read-only ref checks). */
  bareClonePath?(repoName: string): string;
}

export interface CoordinatedGitHubDeps {
  /** Current PR description (null when unavailable). */
  getPullRequestBody(slug: string, prNumber: number): Promise<string | null>;
  /** Replace a PR's description. */
  updatePullRequestBody(slug: string, prNumber: number, body: string): Promise<void>;
}

export interface CoordinatedTaskDeps {
  config: WorkspaceConfig;
  workspaceDir: string;
  store: CoordinationStore;
  /** Shared run-record store (the pipeline subprocesses write here too). */
  runs: RunStore;
  repoManager: OrchestratorRepoManager;
  /** Per-repo run lock factory (injected for tests). */
  repoLock: (repoName: string) => LockManager;
  /** Agent-backed planner (injected for tests; see planner-agent.ts). */
  planner: (input: PlanningTaskInput) => Promise<PlannerResult>;
  /** GitHub backend for sibling-link reconciliation (optional). */
  github?: CoordinatedGitHubDeps;
  /** Task runner (injected for tests; defaults to the CLI subprocess). */
  runTask?: (
    taskKey: string,
    extraArgs: string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<boolean>;
  /** Extra CLI args per task run (same as fleet mode). */
  extraArgs: string[];
  /** Routing-skip recorder for unplannable tasks. */
  recordSkip: (reason: string) => void;
  verbose?: boolean;
}

/**
 * Begin and end markers around the coordination section of a PR body so
 * reconciliation REPLACES it instead of appending duplicates.
 */
function sectionMarkers(coordinationId: string): { open: string; close: string } {
  return {
    open: `<!-- devintern-coordination:${coordinationId} -->`,
    close: `<!-- /devintern-coordination:${coordinationId} -->`,
  };
}

/** Sibling view used while rendering the coordination section. */
interface SiblingView {
  repo: string;
  prUrl?: string;
}

/**
 * Render the coordination section embedded in every PR description: the
 * original task, the repository's role, dependency context, the coordination
 * ID, and all known sibling PR links.
 */
export function buildCoordinationSection(options: {
  coordinationId: string;
  taskKey: string;
  entry: { repo: string; rationale?: string; change?: string; dependencies: string[] };
  siblings: SiblingView[];
}): string {
  const { coordinationId, taskKey, entry, siblings } = options;
  const { open, close } = sectionMarkers(coordinationId);
  const lines: string[] = [open, `## 🔗 Coordinated task ${taskKey}`, ""];

  lines.push(
    `This pull request belongs to coordinated effort \`${coordinationId}\` ` +
      `across ${siblings.length} repositories.`,
  );
  lines.push("");
  if (entry.rationale) {
    lines.push(`**Role of ${entry.repo}:** ${entry.rationale}`);
  }
  if (entry.change) {
    lines.push(`**Planned change here:** ${entry.change}`);
  }
  const dependencySiblings = entry.dependencies
    .map((dependency) => siblings.find((sibling) => sibling.repo === dependency))
    .filter((sibling): sibling is SiblingView => Boolean(sibling));
  if (dependencySiblings.length > 0) {
    lines.push(
      `**Depends on:** ${dependencySiblings
        .map((sibling) => (sibling.prUrl ? `[${sibling.repo}](${sibling.prUrl})` : sibling.repo))
        .join(", ")}`,
    );
  }
  lines.push("**All repositories in this effort:**");
  for (const sibling of siblings) {
    lines.push(
      sibling.prUrl ? `- ${sibling.repo}: ${sibling.prUrl}` : `- ${sibling.repo}: (PR pending)`,
    );
  }
  lines.push("", close);
  return lines.join("\n");
}

/**
 * Insert or replace the coordination section inside a PR body.
 *
 * When the body already carries the section (e.g. written at creation time
 * without sibling links), only that section is replaced; otherwise it is
 * appended. The rest of the description is never touched.
 */
export function applyCoordinationSection(
  body: string | null,
  section: string,
  coordinationId: string,
): string {
  const base = body ?? "";
  const { open, close } = sectionMarkers(coordinationId);
  const openIndex = base.indexOf(open);
  const closeIndex = base.indexOf(close);
  if (openIndex !== -1 && closeIndex !== -1 && closeIndex > openIndex) {
    return `${base.slice(0, openIndex)}${section}${base.slice(closeIndex + close.length)}`;
  }
  const trimmed = base.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${section}` : section;
}

/** Environment keys consumed by the single-repo workflow (see index.ts). */
export function coordinationEnv(options: {
  coordinationId: string;
  branch: string;
  footer: string;
}): Record<string, string> {
  return {
    DEVINTERN_COORDINATION_ID: options.coordinationId,
    DEVINTERN_FEATURE_BRANCH: options.branch,
    DEVINTERN_PR_FOOTER: options.footer,
  };
}

/** Whether a coordination-run status means "no further execution needed". */
function isTerminalRunStatus(status: CoordinationRunStatus): boolean {
  return status === "succeeded" || status === "skipped";
}

/** Whether a prerequisite blocks its dependents. */
function isBlockingRunStatus(status: CoordinationRunStatus | undefined): boolean {
  return status === "failed" || status === "blocked";
}

/**
 * Find the pipeline run record the subprocess just wrote for one repo:
 * the newest `runs` row for this coordination ID beyond `afterRunId` that
 * carries a PR URL.
 */
function harvestPrFromRuns(
  runs: RunStore,
  coordinationId: string,
  afterRunId: number,
): RunRecord | undefined {
  return runs
    .listRuns({ coordinationId, limit: 50 })
    .filter((run) => run.id > afterRunId && Boolean(run.prUrl))
    .sort((a, b) => b.id - a.id)[0];
}

/** Whether the deterministic branch already exists on the remote. */
async function remoteBranchExists(
  deps: CoordinatedTaskDeps,
  repoName: string,
  branch: string,
): Promise<boolean> {
  const barePath = deps.repoManager.bareClonePath?.(repoName);
  if (!barePath) {
    return false;
  }
  const result = await Utils.executeGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    { cwd: barePath },
  );
  return result.success;
}

/**
 * Update all PR descriptions of a coordinated effort so each carries the
 * final sibling link set. Idempotent (marker-scoped replacement) and safe to
 * call repeatedly — including long after implementation, e.g. via
 * `devintern workspace reconcile`.
 *
 * @returns The repos whose descriptions could not be updated (empty on full
 *          success). Failures never throw into the caller's flow; they stay
 *          recoverable coordination errors.
 */
export async function reconcileCoordinatedPrs(
  deps: Pick<CoordinatedTaskDeps, "store" | "github" | "config">,
  coordinationId: string,
): Promise<string[]> {
  const coordination = deps.store.getCoordination(coordinationId);
  const github = deps.github;
  if (!coordination?.plan || !github) {
    return [];
  }

  const runsById = new Map(deps.store.listRuns(coordinationId).map((run) => [run.repo, run]));
  const withPr = [...runsById.values()].filter((run) => run.prUrl);
  // Nothing to cross-link until two PRs exist; a lone PR has no siblings.
  if (withPr.length < 2) {
    return [];
  }

  const plan = coordination.plan;
  const siblings: SiblingView[] = plan.entries.map((entry) => ({
    repo: entry.repo,
    prUrl: runsById.get(entry.repo)?.prUrl,
  }));

  const failedRepos: string[] = [];
  for (const run of withPr) {
    const entry = plan.entries.find((candidate) => candidate.repo === run.repo);
    if (!entry || !run.prNumber || !run.prUrl) {
      continue;
    }
    try {
      // The GitHub slug was persisted at harvest time, so reconciliation
      // works even long after implementation (or from another checkout).
      const slug = run.repoSlug ?? slugOf(deps.config, run.repo);
      if (!slug) {
        continue;
      }
      const body = await github.getPullRequestBody(slug, run.prNumber);
      const section = buildCoordinationSection({
        coordinationId,
        taskKey: plan.taskKey,
        entry,
        siblings,
      });
      await github.updatePullRequestBody(
        slug,
        run.prNumber,
        applyCoordinationSection(body, section, coordinationId),
      );
    } catch (error) {
      console.warn(
        `⚠️  [fleet] sibling-PR reconciliation failed for "${run.repo}" (${coordinationId}): ${
          (error as Error).message
        }. Retry with \`devintern workspace reconcile ${coordinationId}\`.`,
      );
      failedRepos.push(run.repo);
    }
  }

  if (failedRepos.length === 0) {
    deps.store.markReconciled(coordinationId, true);
  }
  return failedRepos;
}

/** GitHub slug of a workspace repo (env override wins over the remote URL). */
function slugOf(config: WorkspaceConfig, repoName: string): string | undefined {
  const repo = findRepo(config, repoName);
  const configured = repo?.env.GITHUB_REPO;
  if (configured) {
    return configured;
  }
  const match = repo?.remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1] ?? undefined;
}

/**
 * Run one coordinated (multi-repo) task end to end.
 *
 * @param deps - Injected dependencies
 * @param input - Task context for planning (key/title/description)
 * @param candidates - Repositories the deterministic routing rules matched
 * @returns True when the task was handled (executed, resumed, or safely
 *          skipped as unplannable); false only when a repository lock was
 *          busy and execution should be retried later.
 */
export async function runCoordinatedTask(
  deps: CoordinatedTaskDeps,
  input: PlanningTaskInput,
  candidates: string[],
): Promise<boolean> {
  const { store, runs, config, repoManager } = deps;

  // ---- Plan (or resume an interrupted effort with its persisted plan). ----
  let coordinationId: string;
  let plan: MultiRepoPlan;
  const existing = store.latestForTask(input.taskKey);
  if (
    existing?.plan &&
    (existing.status === "in_progress" || existing.status === "partial_failure")
  ) {
    coordinationId = existing.coordinationId;
    plan = existing.plan;
    console.log(`🧩 [fleet] resuming coordinated effort ${coordinationId} for ${input.taskKey}`);
  } else {
    const planning = await deps.planner(input);
    if (!planning.ok) {
      // Fail safely BEFORE any mutation: record why, surface loudly, and
      // count the task as handled (dedupe keeps it out until it changes).
      deps.recordSkip("unplanned");
      console.warn(
        `⚠️  [fleet] ${input.taskKey}: multi-repo planning failed; skipping.\n` +
          planning.errors.map((error) => `     - ${error}`).join("\n"),
      );
      return true;
    }
    coordinationId = generateCoordinationId(input.taskKey);
    plan = {
      taskKey: input.taskKey,
      coordinationId,
      entries: planning.entries,
      executionOrder: planning.executionOrder,
    };
  }

  // ---- Persist parent + per-repo rows (idempotent) BEFORE executing. ----
  store.ensureCoordination({
    coordinationId,
    taskKey: plan.taskKey,
    tracker: process.env.TASK_TRACKER,
    plan,
  });
  store.setCoordinationStatus(coordinationId, "in_progress");
  store.ensureRuns(plan);

  // Parent run record for the dashboard (one per coordinated effort, linked
  // from the coordination row so resumes reuse it instead of duplicating).
  let parentRunId = store.getCoordination(coordinationId)?.parentRunId;
  if (!parentRunId) {
    parentRunId = runs.createRun({
      origin: "task",
      taskKey: plan.taskKey,
      tracker: process.env.TASK_TRACKER || "jira",
      coordinationId,
    });
    store.setParentRunId(coordinationId, parentRunId);
  }

  // ---- Execute repositories in topological order. ----
  const rowsByRepo = new Map(store.listRuns(coordinationId).map((row) => [row.repo, row]));

  for (const repoName of plan.executionOrder) {
    const entry = plan.entries.find((candidate) => candidate.repo === repoName);
    const row = rowsByRepo.get(repoName);
    if (!entry || !row) {
      continue;
    }
    if (isTerminalRunStatus(row.status)) {
      continue; // resume: completed work is never recreated
    }

    // Failure propagation: a dependent never starts when a prerequisite did
    // not reach the success boundary.
    const blockingDep = entry.dependencies.find((dependency) =>
      isBlockingRunStatus(rowsByRepo.get(dependency)?.status),
    );
    if (blockingDep) {
      store.patchRun(coordinationId, repoName, {
        status: "blocked",
        reason: `prerequisite "${blockingDep}" did not succeed`,
      });
      continue;
    }
    const unfinishedDep = entry.dependencies.find((dependency) => {
      const status = rowsByRepo.get(dependency)?.status;
      return status !== undefined && !isTerminalRunStatus(status);
    });
    if (unfinishedDep) {
      store.patchRun(coordinationId, repoName, {
        status: "blocked",
        reason: `prerequisite "${unfinishedDep}" has not reached the success boundary`,
      });
      continue;
    }

    const repoConfig = findRepo(config, repoName);
    if (!repoConfig) {
      store.patchRun(coordinationId, repoName, {
        status: "failed",
        reason: "repository missing from workspace config",
      });
      continue;
    }

    const lock = deps.repoLock(repoName);
    const lockResult = lock.acquire();
    if (!lockResult.success) {
      console.warn(
        `⚠️  [fleet] repo "${repoName}" is busy (${lockResult.message}); ` +
          `${plan.taskKey} stays resumable.`,
      );
      store.patchRun(coordinationId, repoName, { status: "pending" });
      return false;
    }

    console.log(`🧩 [fleet] ${plan.taskKey} → ${repoName} (coordinated ${coordinationId})`);
    store.patchRun(coordinationId, repoName, { status: "in_progress" });
    const runsBefore = Math.max(
      0,
      ...runs.listRuns({ coordinationId, limit: 200 }).map((run) => run.id),
    );

    try {
      await repoManager.ensureBareClone(repoConfig);
      await repoManager.fetch(repoName);

      const branch = coordinationBranchName(repoConfig, coordinationId);
      store.patchRun(coordinationId, repoName, { branch });

      const worktree = await repoManager.createTaskWorktree(
        repoConfig,
        `${plan.taskKey}-${coordinationId}`.toLowerCase(),
      );

      // Pre-creation footer: role/deps context + coordination ID; sibling
      // links are added by reconciliation once every PR exists.
      const footer = buildCoordinationSection({
        coordinationId,
        taskKey: plan.taskKey,
        entry,
        siblings: plan.entries.map((candidate) => ({ repo: candidate.repo })),
      });
      const env = {
        ...buildRepoEnv(repoConfig, deps.workspaceDir),
        ...coordinationEnv({ coordinationId, branch, footer }),
      };

      const runTask = deps.runTask ?? (await import("../task-polling-acquirer")).runTaskViaCli;
      const ok = await runTask(plan.taskKey, deps.extraArgs, { cwd: worktree, env });

      if (ok) {
        await repoManager.removeTaskWorktree(repoName, worktree);
        const harvested = harvestPrFromRuns(runs, coordinationId, runsBefore);
        const branchExists = await remoteBranchExists(deps, repoName, branch);
        if (harvested?.prUrl) {
          store.patchRun(coordinationId, repoName, {
            status: "succeeded",
            prUrl: harvested.prUrl,
            prNumber: harvested.prNumber,
            runId: harvested.id,
            repoSlug: slugOf(config, repoName),
            reason: null, // clear any stale failure reason from a previous attempt
          });
        } else if (branchExists) {
          store.patchRun(coordinationId, repoName, { status: "succeeded", reason: null });
        } else {
          // Selected but no required diff: excluded from branch/PR creation
          // without breaking dependent visibility.
          store.patchRun(coordinationId, repoName, {
            status: "skipped",
            reason: "no changes produced by the agent",
          });
        }
      } else {
        store.patchRun(coordinationId, repoName, {
          status: "failed",
          reason: "implementation pipeline exited unsuccessfully",
        });
      }
    } catch (error) {
      store.patchRun(coordinationId, repoName, {
        status: "failed",
        reason: (error as Error).message,
      });
    } finally {
      lock.release();
    }

    const updated = store.getRun(coordinationId, repoName);
    rowsByRepo.set(repoName, updated ?? row);
  }

  // ---- Terminal parent status. ----
  const allRows = [...rowsByRepo.values()];
  const effortCompleted = allRows.every((row) => isTerminalRunStatus(row.status));
  store.setCoordinationStatus(coordinationId, effortCompleted ? "completed" : "partial_failure");
  runs.finishRun(
    parentRunId,
    effortCompleted ? "succeeded" : "failed",
    effortCompleted
      ? `coordinated effort completed (${allRows.length} repos)`
      : "coordinated effort incomplete; resumable",
  );
  console.log(
    effortCompleted
      ? `✅ [fleet] coordinated effort ${coordinationId} completed`
      : `⚠️  [fleet] coordinated effort ${coordinationId} is partially complete; it resumes when the task changes again`,
  );

  // ---- Sibling-PR reconciliation. ----
  try {
    const failedRepos = await reconcileCoordinatedPrs(deps, coordinationId);
    if (failedRepos.length > 0) {
      console.warn(
        `⚠️  [fleet] ${coordinationId}: PR descriptions for ${failedRepos.join(", ")} still lack sibling links.`,
      );
    }
  } catch (error) {
    console.warn(`⚠️  [fleet] sibling-PR reconciliation failed: ${(error as Error).message}`);
  }

  return true;
}
