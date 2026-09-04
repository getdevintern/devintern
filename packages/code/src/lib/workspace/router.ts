/**
 * Task-to-repo routing for fleet mode.
 *
 * One tracker query drives the whole workspace; each ready task is matched
 * against `[[routing.rules]]` to pick its repository. The policy is
 * deliberately strict: a task routes only when ALL matching rules agree on
 * exactly one repo. Zero matches or matches across different repos are never
 * guessed at — the caller records a skip and the task is retried only when
 * it changes again.
 */

import type { Task } from "../../types/task-tracker";
import type { RoutingRule, WorkspaceConfig } from "./config";

/** The routing-relevant projection of a task. */
export interface RoutableTask {
  key: string;
  /** Tracker project key, when derivable (e.g. `BACK` from `BACK-12`). */
  projectKey?: string;
  components: string[];
  labels: string[];
}

export type RoutingDecision =
  | { kind: "routed"; repo: string; matchedRules: RoutingRule[] }
  | { kind: "ambiguous"; candidates: string[]; matchedRules: RoutingRule[] }
  | { kind: "unrouted" };

/** `PROJ-123`-style keys (Jira, Linear, and friends); numeric/opaque ids have no project prefix. */
const PROJECT_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/;

/**
 * Project a tracker task onto its routing-relevant fields.
 *
 * @param task - Normalized tracker task.
 * @returns Key, derived project key (when the key has a `PROJ-123` shape),
 *          and the task's components and labels.
 */
export function toRoutableTask(task: Pick<Task, "key" | "components" | "labels">): RoutableTask {
  const match = task.key.match(PROJECT_KEY_PATTERN);
  return {
    key: task.key,
    projectKey: match?.[1],
    components: task.components ?? [],
    labels: task.labels ?? [],
  };
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Whether a task satisfies every criterion a rule sets.
 *
 * Set criteria are AND-ed; list criteria match when the task carries any of
 * the listed values. Comparisons are case-insensitive.
 */
export function ruleMatches(task: RoutableTask, rule: RoutingRule): boolean {
  if (rule.project) {
    if (!task.projectKey || norm(task.projectKey) !== norm(rule.project)) {
      return false;
    }
  }
  if (rule.components.length > 0) {
    const taskComponents = new Set(task.components.map(norm));
    if (!rule.components.some((component) => taskComponents.has(norm(component)))) {
      return false;
    }
  }
  if (rule.labels.length > 0) {
    const taskLabels = new Set(task.labels.map(norm));
    if (!rule.labels.some((label) => taskLabels.has(norm(label)))) {
      return false;
    }
  }
  return true;
}

/**
 * Routing rules that apply to tasks acquired by a source.
 *
 * In multi-team workspaces each task is routed within the scope of the team
 * that acquired it ("never guess" stays per-team): rules naming that team
 * always apply, unscoped rules apply to every team, and rules naming another
 * team never match. Without teams every rule applies.
 *
 * @param config - Workspace config providing the routing rules.
 * @param team - Acquiring team's name, or undefined in single-defaults mode.
 */
export function effectiveRoutingRules(
  config: Pick<WorkspaceConfig, "routing">,
  team?: string,
): RoutingRule[] {
  if (!team) {
    return config.routing;
  }
  return config.routing.filter((rule) => !rule.team || rule.team.toLowerCase() === norm(team));
}

/**
 * Decide which repo a task belongs to.
 *
 * @param task - Routing projection (see {@link toRoutableTask}).
 * @param config - Workspace config providing the routing rules.
 * @returns `routed` when all matching rules agree on one repo; `ambiguous`
 *          when they point at different repos (candidates sorted, deduped);
 *          `unrouted` when nothing matches. Never guesses.
 */
export function routeTask(task: RoutableTask, config: WorkspaceConfig): RoutingDecision {
  return routeTaskWithRules(
    task,
    config.routing,
    config.repos.length === 1 ? config.repos[0]!.name : undefined,
  );
}

/**
 * Like {@link routeTask}, but against an explicit rule list — the team-
 * scoped slice from {@link effectiveRoutingRules}.
 */
export function routeTaskWithRules(
  task: RoutableTask,
  rules: RoutingRule[],
  onlyRepo?: string,
): RoutingDecision {
  const matchedRules = rules.filter((rule) => ruleMatches(task, rule));
  const repos = [...new Set(matchedRules.map((rule) => rule.repo))].sort();

  if (repos.length === 1) {
    return { kind: "routed", repo: repos[0]!, matchedRules };
  }
  if (repos.length > 1) {
    return { kind: "ambiguous", candidates: repos, matchedRules };
  }
  // A 1-repo workspace needs no routing rules: N=1 already implies the only
  // checkout (the same policy automations already use).
  if (onlyRepo) {
    return { kind: "routed", repo: onlyRepo, matchedRules: [] };
  }
  return { kind: "unrouted" };
}
