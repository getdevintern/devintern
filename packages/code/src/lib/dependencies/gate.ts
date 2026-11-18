/**
 * Task dependency gate: decide whether a task whose work depends on other
 * tasks may start, and from which base.
 *
 * The gate is provider-neutral on purpose. A caller collects
 * {@link DependencyFacts} for each dependency (ad-hoc tasks read them from the
 * local workspace DB; tracker blockers can build the same facts from tracker
 * links plus the run and PR registries), and {@link evaluateDependencyGate}
 * turns them into one decision:
 *
 * - `ready` — the task may be claimed. In stacked mode it may carry the one
 *   unmerged dependency to branch from and target ({@link StackBase}).
 * - `waiting` — a dependency has not reached the state the mode needs yet.
 * - `blocked` — a dependency failed, escalated, was abandoned, or its PR was
 *   closed without merging. Re-queueing that dependency can unblock it.
 *
 * Modes:
 * - `merged`: every dependency's PR must be merged (or the
 *   dependency succeeded without a PR). The run starts from the default branch.
 * - `stacked` (default): every dependency's latest run must have succeeded. With exactly
 *   one dependency still unmerged, the task branches from and targets that
 *   dependency's branch; with two or more unmerged it waits until at most one
 *   remains (a branch has one base); with none unmerged it behaves like
 *   `merged`.
 */

import type { RunStatus } from "../state/run-recorder";

/** How a dependent task waits on its dependencies. */
export type DependencyMode = "merged" | "stacked";

export const DEPENDENCY_MODES = ["merged", "stacked"] as const satisfies readonly DependencyMode[];

/**
 * Mode used when neither the task nor `[defaults].dependency_mode` sets one,
 * for a repo whose stacked PRs the worker maintains (GitHub). Other repos
 * default to `merged` ({@link resolveDependencyMode}): their stacked PRs would
 * never be retargeted or restacked after the base merges.
 */
export const DEFAULT_DEPENDENCY_MODE: DependencyMode = "stacked";

/** Whether a value is a known {@link DependencyMode}. */
export function isDependencyMode(value: unknown): value is DependencyMode {
  return typeof value === "string" && (DEPENDENCY_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the mode for one task: a per-task override (`--stack` /
 * `--wait-merge`) wins over the workspace default, which wins over
 * {@link DEFAULT_DEPENDENCY_MODE} for a repo whose stacked PRs are maintained
 * (`stackMaintained`) and `merged` for any other repo.
 */
export function resolveDependencyMode(input: {
  override?: DependencyMode;
  configured?: DependencyMode;
  stackMaintained: boolean;
}): DependencyMode {
  return (
    input.override ??
    input.configured ??
    (input.stackMaintained ? DEFAULT_DEPENDENCY_MODE : "merged")
  );
}

/** Where a dependency's own work item stands. */
export type DependencyWorkState =
  | "missing"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

/** A dependency's PR as far as the gate needs it. */
export interface DependencyPr {
  number: number;
  url?: string;
  branch?: string;
  /**
   * `closed-unknown`: closed, but the recorder could not tell whether it
   * merged. The caller may ask the code host and record the answer.
   */
  state: "open" | "merged" | "closed" | "closed-unknown";
  /**
   * When the code host merged it (epoch ms), from the host's PR payload. Not
   * the worker's first-observed time: only the host's time orders merges.
   */
  mergedAt?: number;
  /** The branch it merged into, from the host's PR payload. */
  mergedInto?: string;
  /**
   * Whether {@link mergedInto} is the repo's default branch, when the host
   * payload says (GitHub does). `undefined` when unknown.
   */
  mergedIntoDefault?: boolean;
}

/**
 * A code host's answer for a dependency PR that is no longer open. For a
 * merge, the host's merge facts let the gate order stacked merges even when
 * no registry row could record them.
 */
export interface MergeStateAnswer {
  state: "merged" | "closed";
  mergedAt?: DependencyPr["mergedAt"];
  mergedInto?: DependencyPr["mergedInto"];
  mergedIntoDefault?: DependencyPr["mergedIntoDefault"];
}

/** Everything the gate knows about one dependency. */
export interface DependencyFacts {
  key: string;
  work: DependencyWorkState;
  /** The dependency's most recent run, if any. */
  latestRun?: {
    status: RunStatus;
    prNumber?: number;
    prUrl?: string;
    branch?: string;
    /** Set when the run pushed its branch but could not open the PR. */
    prFailure?: string;
  };
  /** The PR that run opened, from the PR registry. */
  pr?: DependencyPr;
  /**
   * The dependency's own stack base: set when its latest claim was stacked on
   * another (then unmerged) task, so its PR targeted that task's branch. A
   * merge of such a PR lands in the base's branch, not the default branch, so
   * the dependency is only as merged as its base is.
   */
  stackBase?: DependencyFacts;
  /**
   * Set when the dependency's own stacked PR is blocked because the PR it is
   * stacked on closed without merging (the stacked-PR maintainer's
   * `stack_notice`). The dependency's run still reads `succeeded`, so this is
   * what keeps its dependents blocked while that PR is open; it clears if the
   * base is reopened or the PR is retargeted by hand, and is ignored once the
   * PR merges or closes.
   */
  stackBlocked?: string;
}

/** One dependency, classified. */
export type DependencyStatus =
  | { key: string; state: "satisfied"; via: "merged" | "no-pr"; pr?: DependencyPr }
  | { key: string; state: "unmerged"; pr: DependencyPr }
  | { key: string; state: "merge-unknown"; pr: DependencyPr; reason?: string }
  | { key: string; state: "pending"; reason: string }
  | { key: string; state: "blocked"; reason: string };

/** The base a stacked task branches from and targets its PR at. */
export interface StackBase {
  taskKey: string;
  branch: string;
  prNumber: number;
  prUrl?: string;
}

export type DependencyGateDecision =
  | { kind: "ready"; statuses: DependencyStatus[]; stackedOn?: StackBase }
  | {
      kind: "waiting";
      reason: string;
      statuses: DependencyStatus[];
      /**
       * Dependency PRs worth asking the code host about, since the answer may
       * change the decision: closed PRs whose merge state is unknown, merged
       * stacked PRs whose merge order against their base is unknown, plus
       * unmerged (`open`) PRs the gate is waiting on. The registry only learns
       * a PR closed when a poller observes it (not for every host or
       * credential setup), so an `open` row can be stale.
       */
      mergeStateLookups: Array<{ key: string; pr: DependencyPr }>;
    }
  | { kind: "blocked"; reason: string; statuses: DependencyStatus[] };

function prLabel(pr: Pick<DependencyPr, "number">): string {
  return `PR #${pr.number}`;
}

/**
 * Classify a dependency whose PR merged while stacked on another task's
 * branch.
 *
 * Retargeted to the default branch first (e.g. once the base merged), its
 * work landed there directly; retargeted to some other branch (the host says
 * it is not the default branch), its work is not on the default branch, so
 * the dependency is blocked. When the host does not say which branch is the
 * default, a retargeted merge counts as landed. Otherwise its work is wherever the
 * base's work is: an unmerged base becomes the dependency to wait on (merged
 * mode) or stack on (stacked mode; the base's branch now carries the
 * dependency's commits too). A merged base carried the dependency's work only
 * if the dependency merged into the base's branch first; merged after, its
 * commits sit on a branch nothing merges any more. The host's merge times
 * decide the order; until both are known the dependency is `merge-unknown`,
 * so the caller asks the code host.
 */
function classifyMergedIntoStackBase(
  key: string,
  pr: DependencyPr,
  base: DependencyFacts,
): DependencyStatus {
  const baseBranch = base.pr?.branch ?? base.latestRun?.branch;
  if (pr.mergedInto !== undefined && baseBranch !== undefined && pr.mergedInto !== baseBranch) {
    if (pr.mergedIntoDefault === false) {
      return {
        key,
        state: "blocked",
        reason:
          `${key} ${prLabel(pr)} merged into ${pr.mergedInto}, which is neither the default ` +
          `branch nor ${base.key}'s branch, so its work is not on the default branch; ` +
          `land it there, then re-queue this task`,
      };
    }
    return { key, state: "satisfied", via: "merged", pr };
  }
  const status = classifyDependency(base);
  if (status.state === "pending" || status.state === "blocked") {
    return { ...status, key, reason: `${key} merged into ${base.key}'s branch; ${status.reason}` };
  }
  if (status.state !== "satisfied") return status;
  const basePr = base.pr;
  if (basePr?.state !== "merged") return { ...status, key };
  const order = `whether ${key} ${prLabel(pr)} merged before ${base.key} ${prLabel(basePr)}`;
  if (pr.mergedAt === undefined) {
    return { key, state: "merge-unknown", pr, reason: `checking ${order}` };
  }
  if (basePr.mergedAt === undefined) {
    return { key, state: "merge-unknown", pr: basePr, reason: `checking ${order}` };
  }
  if (pr.mergedAt > basePr.mergedAt) {
    return {
      key,
      state: "blocked",
      reason:
        `${key} ${prLabel(pr)} merged into ${pr.mergedInto ?? baseBranch ?? `${base.key}'s branch`} ` +
        `after ${base.key} ${prLabel(basePr)} merged, so its work is not on the default branch; ` +
        `land it there, then re-queue this task`,
    };
  }
  return { ...status, key };
}

/** Classify one dependency from its facts. */
export function classifyDependency(facts: DependencyFacts): DependencyStatus {
  const { key, work, latestRun } = facts;
  if (work === "queued") return { key, state: "pending", reason: `${key} not started` };
  if (work === "running") return { key, state: "pending", reason: `${key} running` };
  if (work === "failed") return { key, state: "blocked", reason: `${key} failed` };
  if (work === "cancelled") return { key, state: "blocked", reason: `${key} was cancelled` };
  if (!latestRun) {
    // A settled row with no run (e.g. skipped as unchanged) produced nothing
    // to wait for; a missing row with no run is unknown work.
    return work === "done"
      ? { key, state: "satisfied", via: "no-pr" }
      : { key, state: "blocked", reason: `${key} not found` };
  }
  switch (latestRun.status) {
    case "failed":
    case "escalated":
    case "abandoned":
      return { key, state: "blocked", reason: `${key} ${latestRun.status}` };
    case "in_progress":
    case "deferred":
      return { key, state: "pending", reason: `${key} running` };
    case "succeeded":
      break;
  }
  const pr: DependencyPr | undefined =
    facts.pr ??
    (latestRun.prNumber !== undefined
      ? {
          number: latestRun.prNumber,
          url: latestRun.prUrl,
          branch: latestRun.branch,
          // A run that recorded a PR the registry does not know is treated as
          // open: nothing proves it merged.
          state: "open",
        }
      : undefined);
  if (!pr) {
    // Pushed but no PR: the work exists only on the branch, so the default
    // branch (merged mode) and a stack base (stacked mode) both lack it.
    if (latestRun.prFailure !== undefined) {
      return { key, state: "blocked", reason: `${key} pushed but PR creation failed` };
    }
    return { key, state: "satisfied", via: "no-pr" };
  }
  const withBranch = { ...pr, branch: pr.branch ?? latestRun.branch };
  switch (pr.state) {
    case "merged":
      return facts.stackBase
        ? classifyMergedIntoStackBase(key, withBranch, facts.stackBase)
        : { key, state: "satisfied", via: "merged", pr: withBranch };
    case "closed":
      return {
        key,
        state: "blocked",
        reason: `${key} ${prLabel(pr)} closed without merging`,
      };
    case "closed-unknown":
      return { key, state: "merge-unknown", pr: withBranch };
    case "open":
      // The stack block only matters while the stacked PR is open on its
      // closed base; once it merges or closes, its PR state decides.
      if (facts.stackBlocked) {
        return { key, state: "blocked", reason: `${key} ${facts.stackBlocked}` };
      }
      return { key, state: "unmerged", pr: withBranch };
  }
}

/**
 * Decide whether a dependent task may start.
 *
 * @param mode - The task's resolved {@link DependencyMode}
 * @param facts - One entry per dependency (an empty list is always ready)
 */
export function evaluateDependencyGate(
  mode: DependencyMode,
  facts: readonly DependencyFacts[],
): DependencyGateDecision {
  const statuses = facts.map(classifyDependency);
  const blocked = statuses.filter((status) => status.state === "blocked");
  if (blocked.length > 0) {
    return { kind: "blocked", reason: blocked.map((status) => status.reason).join("; "), statuses };
  }

  const pending = statuses.filter((status) => status.state === "pending");
  const unknown = statuses.filter((status) => status.state === "merge-unknown");
  // Two dependencies can resolve to the same unmerged PR (a dependency and the
  // stack base its merged PR landed in); count that PR once.
  const unmerged = statuses
    .filter((status) => status.state === "unmerged")
    .filter(
      (status, index, list) =>
        list.findIndex((other) => other.pr.number === status.pr.number) === index,
    );
  const unknownLookups = unknown.map((status) => ({ key: status.key, pr: status.pr }));
  const unmergedLookups = unmerged.map((status) => ({ key: status.key, pr: status.pr }));
  const unknownReasons = unknown.map(
    (status) =>
      status.reason ?? `${status.key} ${prLabel(status.pr)} closed; checking whether it merged`,
  );

  if (mode === "merged") {
    if (pending.length === 0 && unknown.length === 0 && unmerged.length === 0) {
      return { kind: "ready", statuses };
    }
    const reasons = [
      ...pending.map((status) => status.reason),
      ...unmerged.map((status) => `${status.key} ${prLabel(status.pr)} not merged`),
      ...unknownReasons,
    ];
    return {
      kind: "waiting",
      reason: reasons.join("; "),
      statuses,
      mergeStateLookups: [...unknownLookups, ...unmergedLookups],
    };
  }

  // Stacked: every dependency must have finished successfully first.
  if (pending.length > 0 || unknown.length > 0) {
    const reasons = [...pending.map((status) => status.reason), ...unknownReasons];
    return {
      kind: "waiting",
      reason: reasons.join("; "),
      statuses,
      mergeStateLookups: unknownLookups,
    };
  }
  if (unmerged.length === 0) return { kind: "ready", statuses };
  const [only] = unmerged;
  if (unmerged.length === 1 && only) {
    const branch = only.pr.branch;
    if (!branch) {
      // Without the dependency's branch there is nothing to stack on; wait
      // for the merge instead of silently starting from the default branch.
      return {
        kind: "waiting",
        reason: `${only.key} ${prLabel(only.pr)} not merged (its branch is unknown, so it cannot be stacked on)`,
        statuses,
        mergeStateLookups: unmergedLookups,
      };
    }
    return {
      kind: "ready",
      statuses,
      stackedOn: { taskKey: only.key, branch, prNumber: only.pr.number, prUrl: only.pr.url },
    };
  }
  const list = unmerged.map((status) => `${status.key} ${prLabel(status.pr)}`).join(", ");
  return {
    kind: "waiting",
    reason:
      `${unmerged.length} dependencies unmerged (${list}); ` +
      "stacked mode waits until at most one remains unmerged",
    statuses,
    mergeStateLookups: unmergedLookups,
  };
}

/**
 * Whether adding `taskKey → dependsOn` edges would close a cycle.
 *
 * @param taskKey - The task gaining the dependencies
 * @param dependsOn - Its direct dependencies
 * @param edgesOf - Existing direct dependencies of any task key
 * @returns The cycle as a key path (`a → b → a`), or `null`
 */
export function findDependencyCycle(
  taskKey: string,
  dependsOn: readonly string[],
  edgesOf: (key: string) => readonly string[],
): string[] | null {
  const visited = new Set<string>();
  const walk = (key: string, path: string[]): string[] | null => {
    if (key === taskKey) return [...path, key];
    if (visited.has(key)) return null;
    visited.add(key);
    for (const next of edgesOf(key)) {
      const found = walk(next, [...path, key]);
      if (found) return found;
    }
    return null;
  };
  for (const dependency of dependsOn) {
    const found = walk(dependency, [taskKey]);
    if (found) return found;
  }
  return null;
}
