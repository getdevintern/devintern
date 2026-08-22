/**
 * Multi-repo plans for coordinated (cross-repository) tasks.
 *
 * A plan is the agent-generated, then strictly validated, description of
 * which workspace repositories a task touches, why each is selected, what
 * should change there, and how they depend on each other. Validation rejects
 * unknown repositories, duplicate selections, dependencies outside the
 * selection, and dependency cycles BEFORE any branch, clone, or push happens.
 * Execution order is a deterministic topological order of that dependency
 * graph.
 *
 * Coordination IDs tie one parent effort to every per-repository run: they
 * are generated once per coordinated attempt, persisted with the plan, and
 * reused on resume so branch names and run records stay stable across
 * interruptions. Branch names derive purely from the coordination ID (plus
 * the repository's branch prefix convention), making them deterministic and
 * collision-resistant without extra coordination state.
 */

import { randomBytes } from "crypto";

import { parseAgentJsonObject } from "../agent-json";
import type { RepoConfig, WorkspaceConfig } from "./config";

/** One planned repository in a multi-repo plan. */
export interface PlanEntry {
  /** Workspace repository name (must match a `[[repos]]` entry). */
  repo: string;
  /** Why this repository is part of the effort (agent rationale). */
  rationale: string;
  /** What is intended to change in this repository. */
  change: string;
  /**
   * Other repositories IN THIS PLAN whose work must complete first. Must be
   * a subset of the selected repositories; cycles are rejected.
   */
  dependencies: string[];
}

/** Raw planner response before validation (agent JSON shape). */
export interface RawPlanEntry {
  repo?: unknown;
  rationale?: unknown;
  change?: unknown;
  dependencies?: unknown;
}

/**
 * Stable identifier linking a parent effort to all of its per-repository
 * runs: `{task-key-lower}-{token}` where the token is 8 base36 characters
 * (timestamp + randomness) — collision-resistant yet readable, and safe in
 * branch names.
 */
export function generateCoordinationId(taskKey: string): string {
  const key = taskKey.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const timeToken = Date.now().toString(36);
  const randomToken = randomBytes(3).toString("hex");
  return `${key}-${timeToken}${randomToken}`;
}

/**
 * Deterministic feature branch for one planned repository.
 *
 * `{branch-prefix}/{coordination-id}` — derived purely from the coordination
 * ID (so retries/resumes reuse it), unique per coordinated effort (no
 * collision with plain `feature/{task-key}` branches), and prefixed by the
 * repository's own branch convention (`branch_prefix`, default `feature`).
 */
export function coordinationBranchName(repo: RepoConfig, coordinationId: string): string {
  const prefix = repo.branchPrefix?.trim() || "feature";
  return `${prefix}/${coordinationId}`;
}

/** Parse and normalize a raw agent plan response into candidate entries. */
export function parsePlanEntries(output: string): PlanEntry[] {
  const parsed = parseAgentJsonObject(output, "repos");
  const rawRepos = parsed.repos;
  if (!Array.isArray(rawRepos)) {
    throw new Error('Planner response field "repos" must be an array.');
  }

  const entries: PlanEntry[] = [];
  for (const [index, item] of rawRepos.entries()) {
    if (item === null || typeof item !== "object") {
      throw new Error(`Planner response repos[${index}] must be an object.`);
    }
    const raw = item as RawPlanEntry;
    if (typeof raw.repo !== "string" || !raw.repo.trim()) {
      throw new Error(`Planner response repos[${index}].repo must be a non-empty string.`);
    }
    entries.push({
      repo: raw.repo.trim(),
      rationale: typeof raw.rationale === "string" ? raw.rationale.trim() : "",
      change: typeof raw.change === "string" ? raw.change.trim() : "",
      dependencies: Array.isArray(raw.dependencies)
        ? raw.dependencies.filter(
            (dependency): dependency is string => typeof dependency === "string",
          )
        : [],
    });
  }
  return entries;
}

export interface PlanValidationOk {
  ok: true;
  /** Selected repositories in deterministic topological execution order. */
  executionOrder: string[];
}

export interface PlanValidationError {
  ok: false;
  /** Every validation problem found (fixable in one pass). */
  errors: string[];
}

export type PlanValidationResult = PlanValidationOk | PlanValidationError;

/** The validated multi-repo plan persisted with the coordinated run. */
export interface MultiRepoPlan {
  taskKey: string;
  coordinationId: string;
  entries: PlanEntry[];
  /** Deterministic topological execution order of `entries[].repo`. */
  executionOrder: string[];
}

/**
 * Validate a candidate plan against the workspace configuration and compute
 * its deterministic execution order.
 *
 * Rejects, before any mutation:
 * - empty selections (the planner must fail safely instead of guessing),
 * - references to repositories not configured in the workspace,
 * - duplicate selections,
 * - self-dependencies and dependencies on unselected repositories (a likely
 *   omitted dependency must fail loudly, not silently),
 * - dependency cycles (reported with the cycle path).
 *
 * The returned order breaks ties alphabetically so identical plans always
 * execute identically.
 */
export function validateAndOrderPlan(
  entries: PlanEntry[],
  config: WorkspaceConfig,
): PlanValidationResult {
  const errors: string[] = [];

  if (entries.length === 0) {
    return { ok: false, errors: ["Plan selected no repositories; refusing to guess."] };
  }

  const selected = new Map<string, PlanEntry>();
  for (const entry of entries) {
    if (!config.repos.some((repo) => repo.name === entry.repo)) {
      errors.push(`Repository "${entry.repo}" is not configured in the workspace.`);
      continue;
    }
    if (selected.has(entry.repo)) {
      errors.push(`Repository "${entry.repo}" is selected more than once.`);
      continue;
    }
    selected.set(entry.repo, entry);
  }

  for (const entry of selected.values()) {
    for (const dependency of entry.dependencies) {
      if (dependency === entry.repo) {
        errors.push(`Repository "${entry.repo}" depends on itself.`);
        continue;
      }
      if (!config.repos.some((repo) => repo.name === dependency) && !selected.has(dependency)) {
        errors.push(
          `Repository "${entry.repo}" depends on "${dependency}", which is neither selected nor configured.`,
        );
        continue;
      }
      if (config.repos.some((repo) => repo.name === dependency) && !selected.has(dependency)) {
        errors.push(
          `Repository "${entry.repo}" depends on "${dependency}", which was not selected; ` +
            "add it to the plan or drop the dependency.",
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const order = topologicalOrder(entries);
  if (!order.ok) {
    return { ok: false, errors: order.errors };
  }
  return { ok: true, executionOrder: order.executionOrder };
}

/**
 * Deterministic topological order (Kahn's algorithm; alphabetical tie-break
 * among simultaneously ready nodes). Reports a cycle path when the graph is
 * not acyclic.
 */
export function topologicalOrder(
  entries: PlanEntry[],
): PlanValidationOk | { ok: false; errors: string[] } {
  const byRepo = new Map(entries.map((entry) => [entry.repo, entry]));
  const remainingDependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const entry of entries) {
    const dependencies = new Set(
      entry.dependencies.filter(
        (dependency) => dependency !== entry.repo && byRepo.has(dependency),
      ),
    );
    remainingDependencies.set(entry.repo, dependencies);
    for (const dependency of dependencies) {
      if (!dependents.has(dependency)) {
        dependents.set(dependency, new Set());
      }
      dependents.get(dependency)?.add(entry.repo);
    }
  }

  // Alphabetical min-heap stand-in: pick the alphabetically-first ready node
  // each round for stable, reproducible ordering.
  const ready = entries
    .filter((entry) => (remainingDependencies.get(entry.repo)?.size ?? 0) === 0)
    .map((entry) => entry.repo)
    .sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const repo = ready.shift() as string;
    order.push(repo);
    for (const dependent of [...(dependents.get(repo) ?? [])].sort()) {
      const dependencies = remainingDependencies.get(dependent);
      if (!dependencies) {
        continue;
      }
      dependencies.delete(repo);
      if (dependencies.size === 0 && !order.includes(dependent)) {
        const insertAt = ready.findIndex((candidate) => candidate > dependent);
        if (insertAt === -1) {
          ready.push(dependent);
        } else {
          ready.splice(insertAt, 0, dependent);
        }
      }
    }
  }

  if (order.length !== entries.length) {
    const stuck = entries.map((entry) => entry.repo).filter((repo) => !order.includes(repo));
    return {
      ok: false,
      errors: [
        `Dependency cycle detected among: ${describeCycle(stuck, byRepo)}. ` +
          "Circular code dependencies need an explicit staged plan, not an arbitrary order.",
      ],
    };
  }

  return { ok: true, executionOrder: order };
}

/** Render a human-readable cycle path like `a -> b -> a` for error messages. */
function describeCycle(stuck: string[], byRepo: Map<string, PlanEntry>): string {
  const start = stuck[0];
  if (!start) {
    return stuck.join(", ");
  }
  const path: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = start;
  while (current && !visited.has(current)) {
    visited.add(current);
    path.push(current);
    current = byRepo.get(current)?.dependencies.find((dependency) => stuck.includes(dependency));
  }
  path.push(start);
  return path.join(" -> ");
}
