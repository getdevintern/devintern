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
 * - `merged` (default): every dependency's PR must be merged (or the
 *   dependency succeeded without a PR). The run starts from the default branch.
 * - `stacked`: every dependency's latest run must have succeeded. With exactly
 *   one dependency still unmerged, the task branches from and targets that
 *   dependency's branch; with two or more unmerged it waits until at most one
 *   remains (a branch has one base); with none unmerged it behaves like
 *   `merged`.
 */

import type { RunStatus } from "../state/run-recorder";

/** How a dependent task waits on its dependencies. */
export type DependencyMode = "merged" | "stacked";

export const DEPENDENCY_MODES = ["merged", "stacked"] as const satisfies readonly DependencyMode[];

/** Mode used when neither the task nor `[defaults].dependency_mode` sets one. */
export const DEFAULT_DEPENDENCY_MODE: DependencyMode = "merged";

/** Whether a value is a known {@link DependencyMode}. */
export function isDependencyMode(value: unknown): value is DependencyMode {
  return typeof value === "string" && (DEPENDENCY_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the mode for one task: a per-task override (`--stack` /
 * `--wait-merge`) wins over the workspace default, which wins over
 * {@link DEFAULT_DEPENDENCY_MODE}.
 */
export function resolveDependencyMode(input: {
  override?: DependencyMode;
  configured?: DependencyMode;
}): DependencyMode {
  return input.override ?? input.configured ?? DEFAULT_DEPENDENCY_MODE;
}

/** Where a dependency's own work item stands. */
export type DependencyWorkState = "missing" | "queued" | "running" | "done" | "failed";

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
  };
  /** The PR that run opened, from the PR registry. */
  pr?: DependencyPr;
}

/** One dependency, classified. */
export type DependencyStatus =
  | { key: string; state: "satisfied"; via: "merged" | "no-pr"; pr?: DependencyPr }
  | { key: string; state: "unmerged"; pr: DependencyPr }
  | { key: string; state: "merge-unknown"; pr: DependencyPr }
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
      /** PRs whose merge state is unknown; resolving them may change the decision. */
      unknownMergeState: Array<{ key: string; pr: DependencyPr }>;
    }
  | { kind: "blocked"; reason: string; statuses: DependencyStatus[] };

function prLabel(pr: Pick<DependencyPr, "number">): string {
  return `PR #${pr.number}`;
}

/** Classify one dependency from its facts. */
export function classifyDependency(facts: DependencyFacts): DependencyStatus {
  const { key, work, latestRun } = facts;
  if (work === "queued") return { key, state: "pending", reason: `${key} not started` };
  if (work === "running") return { key, state: "pending", reason: `${key} running` };
  if (work === "failed") return { key, state: "blocked", reason: `${key} failed` };
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
  if (!pr) return { key, state: "satisfied", via: "no-pr" };
  const withBranch = { ...pr, branch: pr.branch ?? latestRun.branch };
  switch (pr.state) {
    case "merged":
      return { key, state: "satisfied", via: "merged", pr: withBranch };
    case "closed":
      return {
        key,
        state: "blocked",
        reason: `${key} ${prLabel(pr)} closed without merging`,
      };
    case "closed-unknown":
      return { key, state: "merge-unknown", pr: withBranch };
    case "open":
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
  const unmerged = statuses.filter((status) => status.state === "unmerged");
  const unknownMergeState = unknown.map((status) => ({ key: status.key, pr: status.pr }));
  const unknownReasons = unknown.map(
    (status) => `${status.key} ${prLabel(status.pr)} closed; checking whether it merged`,
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
    return { kind: "waiting", reason: reasons.join("; "), statuses, unknownMergeState };
  }

  // Stacked: every dependency must have finished successfully first.
  if (pending.length > 0 || unknown.length > 0) {
    const reasons = [...pending.map((status) => status.reason), ...unknownReasons];
    return { kind: "waiting", reason: reasons.join("; "), statuses, unknownMergeState };
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
        unknownMergeState: [],
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
    unknownMergeState: [],
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
