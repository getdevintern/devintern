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

import type { EnqueueInjectedTaskResult, InjectedTaskStore } from "../state/injected-tasks";
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
  /** Non-empty task title. */
  title: string;
  /** Markdown description, at most {@link MAX_INJECTED_BODY_CHARS}. */
  body: string;
  /** Dedupe key; reuses an active (pending/running) row with the same key. */
  idempotencyKey?: string;
  /** Audit identity stored on the row (default `local:add`). */
  actor?: string;
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
): EnqueueInjectedTaskResult {
  if (request.idempotencyKey) {
    const existing = store.findActiveByIdempotencyKey(request.idempotencyKey);
    if (existing) return { task: existing, deduplicated: true };
  }

  const dir = injectedTasksDir(workspaceDir);
  // Prompts hold arbitrary operator context, so keep them owner-only like the
  // workspace .env. `mode` only applies to newly created paths.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt++) {
    const taskKey = deriveInjectedTaskKey(request.title, (key) => store.hasTaskKey(key));
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
        title: request.title.trim(),
        body: request.body,
        taskFile,
        idempotencyKey: request.idempotencyKey,
        actor: request.actor ?? "local:add",
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
    return enqueued;
  }
}
