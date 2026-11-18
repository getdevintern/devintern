/**
 * Core enqueue of an ad-hoc ("injected") task, shared by `devintern worker add`
 * and the dashboard's `POST /api/tasks`.
 *
 * Materializes the title/body as an owner-only markdown task file under the
 * workspace's injected-tasks directory, then inserts a durable `pending` row
 * the workspace worker drains on its next poll. An idempotency key dedupes
 * only against an active (pending/running) row; a settled row under the same
 * key is history and a new occurrence is enqueued.
 *
 * Callers own validation (repo membership, title, body size), entitlement, and
 * output; this module only writes the file + row.
 */

import { randomBytes } from "crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

import type { DependencyMode } from "../dependencies/gate";
import { evaluateDependencyGate, findDependencyCycle } from "../dependencies/gate";
import type {
  EnqueueInjectedTaskResult,
  InjectedTask,
  InjectedTaskStore,
} from "../state/injected-tasks";
import { extractDependsOn } from "../utils/general";
import { injectedTasksDir } from "./paths";

/** Maximum body size accepted (matches the run recorder's description cap). */
export const MAX_INJECTED_BODY_CHARS = 20_000;

/** Bound the re-derive/retry loop if many callers race the same title. */
const MAX_TASK_KEY_ATTEMPTS = 50;

/** Filesystem-safe slug derived from a task title. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Derive a unique `local-<slug>` task key.
 *
 * The `local-` prefix keeps generated keys (and therefore `feature/local-…`
 * branches) from colliding with tracker keys, which always carry a
 * `PROJ-123`-style shape.
 */
export function deriveInjectedTaskKey(title: string, isTaken: (key: string) => boolean): string {
  const base = `local-${slugifyTitle(title) || "task"}`;
  if (!isTaken(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Render the local markdown task file the pipeline consumes. */
export function buildInjectedTaskMarkdown(input: {
  taskKey: string;
  title: string;
  body: string;
  now?: Date;
}): string {
  const title = input.title.replace(/\s+/g, " ").trim();
  const created = (input.now ?? new Date()).toISOString();
  const body = input.body.trimEnd();
  return [
    "---",
    `key: ${input.taskKey}`,
    `created_at: ${created}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

/** A per-invocation filename so concurrent callers never share a prompt path. */
function injectedTaskFileName(taskKey: string): string {
  return `${taskKey}-${randomBytes(4).toString("hex")}.md`;
}

/** Whether an insert failed on the `task_key` unique index (lost a key race). */
function isTaskKeyConflict(error: unknown): boolean {
  return /UNIQUE constraint failed: injected_tasks\.task_key/i.test(String(error));
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup.
  }
}

/** A validated ad-hoc task ready to be written to the workspace queue. */
export interface InjectedTaskRequest {
  /** Registered `[[repos]]` name (callers validate membership). */
  repo: string;
  /** Validated `[[teams]]` name whose credentials the run layers. */
  team?: string;
  /** Non-empty task title. */
  title: string;
  /** Markdown description, at most {@link MAX_INJECTED_BODY_CHARS}. */
  body: string;
  /** Dedupe key; reuses an active (pending/running) row with the same key. */
  idempotencyKey?: string;
  /** Audit identity stored on the row (default `local:add`). */
  actor?: string;
  /**
   * Dependencies from `--after`; merged (de-duplicated) with any
   * `Depends on:` lines in {@link body}.
   */
  after?: string[];
  /** Resolved dependency mode (default `merged`); stored only with dependencies. */
  dependencyMode?: DependencyMode;
}

/** A rejected dependency declaration (unknown, cross-repo, or cyclic). */
export class InjectedTaskDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectedTaskDependencyError";
  }
}

/** Dependencies of a new ad-hoc task, after checking them against the queue. */
export interface ResolvedInjectedDependencies {
  /** Keys the task will wait on, de-duplicated in declaration order. */
  dependsOn: string[];
  /**
   * `Depends on:` keys from the body that name no ad-hoc task in this
   * workspace (e.g. a tracker ticket mentioned for context). They are not
   * dependencies; callers may surface them as a warning.
   */
  ignored: string[];
}

/**
 * Collect `--after` keys plus the body's `Depends on:` keys and check them.
 *
 * `--after` is an explicit request, so an unknown key there is an error. A
 * body is free-form markdown written by people and agents, so a `Depends on:`
 * key that matches no ad-hoc task is dropped (reported in `ignored`) rather
 * than rejecting the whole enqueue. Any key that does name a task must be in
 * the same repo.
 *
 * @throws {InjectedTaskDependencyError} unknown `--after` key or cross-repo dependency
 */
export function resolveInjectedDependencies(
  store: InjectedTaskStore,
  repo: string,
  after: readonly string[] | undefined,
  body: string,
): ResolvedInjectedDependencies {
  const explicit = [...new Set((after ?? []).map((key) => key.trim()).filter(Boolean))];
  const fromBody = extractDependsOn(body).filter((key) => !explicit.includes(key));
  const all = [...explicit, ...fromBody];
  if (all.length === 0) return { dependsOn: [], ignored: [] };
  const repos = store.reposByTaskKey(all);
  const unknown = explicit.filter((key) => !repos.has(key));
  if (unknown.length > 0) {
    throw new InjectedTaskDependencyError(
      `unknown dependency ${unknown.join(", ")}: no ad-hoc task with that key in this workspace ` +
        "(check `devintern worker queue` / `devintern worker runs`)",
    );
  }
  const ignored = fromBody.filter((key) => !repos.has(key));
  const dependsOn = all.filter((key) => repos.has(key));
  const foreign = dependsOn.filter((key) => repos.get(key) !== repo);
  if (foreign.length > 0) {
    const detail = foreign.map((key) => `${key} (repo "${repos.get(key)}")`).join(", ");
    throw new InjectedTaskDependencyError(
      `cross-repo dependencies are not supported: ${detail} is not in repo "${repo}"`,
    );
  }
  return { dependsOn, ignored };
}

/** Reject a dependency set that would make `taskKey` (transitively) depend on itself. */
function assertNoDependencyCycle(
  store: InjectedTaskStore,
  taskKey: string,
  dependsOn: readonly string[],
): void {
  const cycle = findDependencyCycle(taskKey, dependsOn, (key) => store.dependenciesOf(key));
  if (cycle) {
    throw new InjectedTaskDependencyError(`dependency cycle: ${cycle.join(" → ")}`);
  }
}

/**
 * Rewrite a task's markdown prompt from its stored row and a (possibly
 * augmented) body, e.g. with a stacked base section added at claim time.
 * Always derived from the row's original body, so a later claim never keeps a
 * stale base from an earlier one.
 */
export function rewriteInjectedTaskFile(
  task: Pick<InjectedTask, "taskKey" | "title" | "taskFile" | "createdAt">,
  body: string,
): void {
  writeFileSync(
    task.taskFile,
    buildInjectedTaskMarkdown({
      taskKey: task.taskKey,
      title: task.title,
      body,
      now: new Date(task.createdAt),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

/** {@link enqueueInjectedTask} result. */
export interface EnqueueInjectedTaskOutcome extends EnqueueInjectedTaskResult {
  /** Body `Depends on:` keys skipped because no ad-hoc task has them. */
  ignoredDependencies: string[];
}

/**
 * Enqueue an ad-hoc task: write its markdown prompt and insert the durable row.
 *
 * An active row under `idempotencyKey` is returned unchanged with
 * `deduplicated: true` and nothing is written. Throws on filesystem/DB
 * failures (callers translate them into their own error surface).
 *
 * @param store - Workspace queue store the worker drains
 * @param workspaceDir - Workspace home (task files live under it)
 * @param request - Validated task fields
 */
export function enqueueInjectedTask(
  store: InjectedTaskStore,
  workspaceDir: string,
  request: InjectedTaskRequest,
): EnqueueInjectedTaskOutcome {
  if (request.idempotencyKey) {
    const existing = store.findActiveByIdempotencyKey(request.idempotencyKey);
    if (existing) return { task: existing, deduplicated: true, ignoredDependencies: [] };
  }

  const { dependsOn, ignored } = resolveInjectedDependencies(
    store,
    request.repo,
    request.after,
    request.body,
  );
  const dependencyMode = request.dependencyMode ?? "merged";

  const dir = injectedTasksDir(workspaceDir);
  // Prompts hold arbitrary operator context, so keep them owner-only like the
  // workspace .env. `mode` only applies to newly created paths.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt++) {
    const taskKey = deriveInjectedTaskKey(request.title, (key) => store.hasTaskKey(key));
    // A new key cannot be referenced by existing rows unless a pruned task's
    // key is reused; check anyway so a stored graph can never loop.
    assertNoDependencyCycle(store, taskKey, dependsOn);
    // Record the initial verdict so the queue view explains the wait before
    // the worker's next gate pass.
    const initial =
      dependsOn.length > 0
        ? evaluateDependencyGate(dependencyMode, store.dependencyFacts(dependsOn))
        : undefined;
    // Unique per call: if a concurrent caller wins the same key or idempotency
    // row, unlinking our own file can never delete the winner's prompt.
    const taskFile = join(dir, injectedTaskFileName(taskKey));
    writeFileSync(
      taskFile,
      buildInjectedTaskMarkdown({ taskKey, title: request.title, body: request.body }),
      { encoding: "utf8", mode: 0o600 },
    );

    let enqueued: EnqueueInjectedTaskResult;
    try {
      enqueued = store.enqueue({
        taskKey,
        repo: request.repo,
        ...(request.team ? { team: request.team } : {}),
        title: request.title.trim(),
        body: request.body,
        taskFile,
        idempotencyKey: request.idempotencyKey,
        actor: request.actor ?? "local:add",
        dependsOn,
        dependencyMode,
        dependencyState: initial && initial.kind !== "ready" ? initial.kind : undefined,
        dependencyReason: initial && initial.kind !== "ready" ? initial.reason : undefined,
      });
    } catch (enqueueError) {
      unlinkQuietly(taskFile);
      // A concurrent caller claimed this task_key first; re-derive (now seeing
      // their committed row) and retry with a suffixed key.
      if (isTaskKeyConflict(enqueueError) && attempt < MAX_TASK_KEY_ATTEMPTS) continue;
      throw enqueueError;
    }

    // Lost an idempotency race: drop our own file and report their row.
    if (enqueued.deduplicated) unlinkQuietly(taskFile);
    return { ...enqueued, ignoredDependencies: enqueued.deduplicated ? [] : ignored };
  }
}
