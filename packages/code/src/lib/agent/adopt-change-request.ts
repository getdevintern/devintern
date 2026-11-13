/**
 * Adopt a change request an agent created on its own.
 *
 * Agents occasionally run `gh pr create` (or the GitLab equivalent) before the
 * pipeline reaches its PR step. If the run then fails, the PR exists but is
 * unlabeled and unknown to review polling. This helper looks up an open change
 * request for the worktree's current branch and, when found, applies
 * `PR_LABELS` and registers it in `agent_prs`.
 *
 * The run remains failed: adoption only makes the existing PR visible to the
 * worker's review/CI paths and applies the workspace's PR metadata.
 */

import { spawnSync } from "child_process";

import type { ChangeRequestIdentity } from "../code-host/provider";
import { PRManager } from "../code-host/manager";
import { parsePrLabels } from "../code-host/shared";
import { recordAgentPrFromUrl } from "../state/worker-state";

/** Minimal manager surface, injected in tests. */
export interface ChangeRequestAdopter {
  findOpenChangeRequest(sourceBranch: string): Promise<ChangeRequestIdentity | undefined>;
  applyLabelsToChangeRequest(identity: ChangeRequestIdentity, labels: string[]): Promise<void>;
}

/** Inputs for {@link adoptAgentCreatedChangeRequest}. */
export interface AdoptChangeRequestOptions {
  /** Task key recorded on the agent PR row. */
  taskKey: string;
  /** Git working directory; defaults to the process cwd (the worktree). */
  cwd?: string;
  /** Explicit branch (tests); otherwise resolved from git. */
  branch?: string;
  /** Labels to apply; defaults to `PR_LABELS` from the environment. */
  labels?: string[];
  /** Manager override (tests). */
  manager?: ChangeRequestAdopter;
  /** Registration override (tests). */
  record?: (identity: ChangeRequestIdentity, branch: string) => void;
}

/** Base branches that must never be treated as an agent feature branch. */
const BASE_BRANCHES = new Set(["main", "master", "trunk", "develop", "HEAD"]);

/**
 * Resolve the current git branch.
 *
 * @param cwd - Directory to inspect.
 * @returns The branch name, or `undefined` when git cannot resolve it.
 */
function currentBranch(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error || result.status !== 0) return undefined;
  const branch = result.stdout.trim();
  return branch || undefined;
}

/**
 * Label and register an agent-created change request after a failed run.
 *
 * Best-effort: every failure is logged and swallowed, because this runs on the
 * path that is already reporting a task failure.
 *
 * @param options - Task key, worktree directory, and optional overrides.
 * @returns The adopted change request, or `undefined` when there is none.
 */
export async function adoptAgentCreatedChangeRequest(
  options: AdoptChangeRequestOptions,
): Promise<ChangeRequestIdentity | undefined> {
  try {
    const cwd = options.cwd ?? process.cwd();
    const branch = options.branch ?? currentBranch(cwd);
    if (!branch || BASE_BRANCHES.has(branch)) return undefined;

    const manager = options.manager ?? new PRManager();
    const identity = await manager.findOpenChangeRequest(branch);
    if (!identity) return undefined;

    const labels = options.labels ?? parsePrLabels(process.env.PR_LABELS);
    if (labels.length > 0) {
      await manager.applyLabelsToChangeRequest(identity, labels);
    }

    if (options.record) {
      options.record(identity, branch);
    } else {
      recordAgentPrFromUrl(identity.webUrl, branch, options.taskKey, identity);
    }

    const noun = identity.provider === "gitlab" ? "merge request" : "pull request";
    console.log(
      `🩹 Adopted existing ${noun} #${identity.number} for branch '${branch}' (run remains failed)`,
    );
    return identity;
  } catch (error) {
    console.warn(`⚠️  Could not adopt an existing pull request: ${(error as Error).message}`);
    return undefined;
  }
}
