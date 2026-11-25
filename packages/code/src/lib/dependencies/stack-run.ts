/**
 * A stacked run whose base moves before the run has opened its PR.
 *
 * A stacked task's run starts on its dependency's branch and targets it (see
 * `stacked-base.ts`). The base PR can merge (and its branch be deleted) while
 * the run is still implementing. The stack maintainer (`stack-maintainer.ts`)
 * only follows stacked PRs that already exist, so the run checks for itself
 * before each step that reads the base (verify and auto-review diffs, push,
 * PR creation):
 *
 * - **Base open, branch present**: nothing to do.
 * - **Base merged** (or its branch is gone and the code host cannot say why):
 *   switch the run's target to the branch the base merged into (normally the
 *   default branch) and rebase the run's branch onto it, dropping the base's
 *   original commits, as the maintainer does for an open stacked PR. After a
 *   squash merge those commits are not on the target, so without the rebase
 *   the PR would show the base's changes again.
 * - **Base closed without merging**: blocked. The caller preserves the work
 *   and escalates with {@link stackBaseRecoveryHint}'s actions.
 */

import type { StackBase } from "./gate";
import { rebaseOntoBase } from "./stack-git";
import type { Git } from "./stack-git";
import { stackBaseRecoveryHint } from "./stack-maintainer";
import type { StackPrSnapshot } from "./stack-maintainer";

/** What the run's base check needs, bound to the run's own checkout. */
export interface RunStackDeps {
  /**
   * The base PR's live state; `null`/`undefined` when the code host cannot
   * tell (unsupported host, missing credentials, failed lookup).
   */
  getBasePr(prNumber: number): Promise<StackPrSnapshot | null | undefined>;
  /** Git in the run's checkout (its feature branch is checked out). */
  git: Git;
  /** The repository's default branch, for a base that vanished unexplained. */
  defaultBranch(): Promise<string>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Outcome of {@link reconcileRunStackBase}. */
export type RunStackBaseResult =
  /** The base is still open (or nothing can be concluded): keep the target. */
  | { kind: "unchanged" }
  /** The run now targets `target`; its branch was rebased onto it when needed. */
  | { kind: "switched"; target: string; summary: string }
  /** The run cannot deliver against any base; `reason` says what to do. */
  | { kind: "blocked"; reason: string };

function prLabel(base: StackBase): string {
  return base.prUrl ? `[PR #${base.prNumber}](${base.prUrl})` : `PR #${base.prNumber}`;
}

/** Whether `origin` still has `branch`; `undefined` when it cannot be checked. */
async function remoteHasBranch(git: Git, branch: string): Promise<boolean | undefined> {
  const result = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
    GIT_TERMINAL_PROMPT: "0",
  });
  return result.success ? result.output.trim() !== "" : undefined;
}

async function revParse(git: Git, ref: string): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.success ? result.output.trim() : null;
}

/**
 * Commits the run's branch was cut from on the base, most precise first: the
 * merge base of `HEAD` with the base PR's final head (exactly the cut point,
 * even when the base gained commits after the run started), then with the
 * run's stale tracking ref of the base branch.
 */
async function oldBaseCandidates(
  git: Git,
  base: StackBase,
  basePr: StackPrSnapshot | null | undefined,
): Promise<string[]> {
  const tips: string[] = [];
  if (basePr?.headSha) {
    // GitHub keeps a merged PR's head reachable through `refs/pull/<n>/head`
    // after its branch is deleted; best effort.
    if (!(await revParse(git, basePr.headSha))) {
      await git(["fetch", "--quiet", "origin", `refs/pull/${base.prNumber}/head`]);
    }
    tips.push(basePr.headSha);
  }
  tips.push(`refs/remotes/origin/${base.branch}`);
  const candidates: string[] = [];
  for (const tip of tips) {
    const sha = await revParse(git, tip);
    if (!sha) continue;
    const mergeBase = await git(["merge-base", "HEAD", sha]);
    if (mergeBase.success && mergeBase.output.trim()) candidates.push(mergeBase.output.trim());
  }
  return candidates;
}

/**
 * Re-resolve a stacked run's base right before a step that uses it.
 *
 * @param base - The stack base the run started on (its current target)
 */
export async function reconcileRunStackBase(
  base: StackBase,
  deps: RunStackDeps,
): Promise<RunStackBaseResult> {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const { git } = deps;
  const label = `${base.taskKey} PR #${base.prNumber}`;

  let basePr: StackPrSnapshot | null | undefined;
  try {
    basePr = await deps.getBasePr(base.prNumber);
  } catch (error) {
    warn(`⚠️  Could not check stack base ${label}: ${(error as Error).message}`);
    basePr = undefined;
  }
  const branchExists = await remoteHasBranch(git, base.branch);

  if (basePr?.state === "open") return { kind: "unchanged" };
  if (basePr?.state === "closed") {
    return {
      kind: "blocked",
      reason:
        `stacked base ${label} (branch '${base.branch}') was closed without merging, ` +
        `so this run has no base to open its PR against. ` +
        `${stackBaseRecoveryHint(base.taskKey, prLabel(base))}, then re-run this task.`,
    };
  }
  // Unknown state: only a branch that is really gone says the base moved.
  if (!basePr && branchExists !== false) return { kind: "unchanged" };

  const target = basePr?.state === "merged" ? basePr.baseRef : await deps.defaultBranch();
  const why =
    basePr?.state === "merged"
      ? `${label} merged into '${target}'`
      : `branch '${base.branch}' of ${label} is gone from the remote and its PR state is unknown; assuming it merged into '${target}'`;
  log(`🔀 Stack base moved: ${why}. Switching this run's base to '${target}'.`);

  const fetch = await git([
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${target}:refs/remotes/origin/${target}`,
  ]);
  const ontoSha = await revParse(git, `refs/remotes/origin/${target}`);
  if (!ontoSha) {
    return {
      kind: "blocked",
      reason:
        `stacked base ${label} moved to '${target}', but origin/${target} could not be fetched` +
        `${fetch.success ? "" : `: ${(fetch.error ?? fetch.output).trim()}`}. ` +
        `Rebase this task's branch onto '${target}' by hand, or re-run this task.`,
    };
  }
  const head = await revParse(git, "HEAD");
  if (!head) throw new Error("the run's checkout has no HEAD");

  const rebase = await rebaseOntoBase(git, {
    head,
    ontoSha,
    onto: target,
    oldBaseCandidates: await oldBaseCandidates(git, base, basePr),
    autostash: true,
  });
  if (rebase.kind === "conflict") {
    return {
      kind: "blocked",
      reason:
        `${why}, but rebasing this run's branch onto '${target}' conflicted (${rebase.detail}). ` +
        `Resolve the conflict on the preserved branch and open the PR against '${target}', or re-run this task.`,
    };
  }
  const summary =
    rebase.kind === "rebased"
      ? `${why}; rebased onto ${target} (${ontoSha.slice(0, 7)}) and targeting it`
      : `${why}; already on ${target}, targeting it`;
  log(`🧱 ${summary}`);
  return { kind: "switched", target, summary };
}
