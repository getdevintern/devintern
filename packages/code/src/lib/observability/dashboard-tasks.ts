/**
 * `POST /api/tasks` — enqueue an ad-hoc task from the dashboard, the HTTP
 * equivalent of `devintern worker add`.
 *
 * The request body is parsed into a {@link DashboardTaskRequest} at the
 * boundary, the target repo is checked against the workspace's `[[repos]]`,
 * and the shared {@link enqueueInjectedTask} writes the markdown prompt plus
 * the durable `injected_tasks` row the workspace worker drains on its next
 * poll. Nothing is spawned here and no worker is started: with no worker
 * running, the task stays queued until one starts.
 *
 * Entitlement is not re-checked per request: both the standalone
 * `devintern dashboard` and the worker-embedded server enforce the same
 * automation license at startup, and the worker re-checks before running.
 */

import { enqueueInjectedTask, MAX_INJECTED_BODY_CHARS } from "../workspace/injected-enqueue";
import { workspaceConfigPath } from "../workspace/paths";
import type { ApiResponse, DashboardData } from "./dashboard-api";
import { loadDashboardWorkspaceConfig } from "./dashboard-workspace";

/** Audit identity recorded on rows enqueued from the dashboard. */
export const DASHBOARD_TASK_ACTOR = "local:dashboard";

/** Upper bound on a client-supplied idempotency key. */
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

/** A validated `POST /api/tasks` body. */
export interface DashboardTaskRequest {
  repo: string;
  title: string;
  body: string;
  idempotencyKey?: string;
}

/** `POST /api/tasks` success body (same shape as `worker add --json`). */
export interface DashboardTaskResponse {
  id: number;
  taskKey: string;
  repo: string;
  status: string;
  deduplicated: boolean;
}

export type ParsedDashboardTaskRequest =
  | { ok: true; request: DashboardTaskRequest }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an untrusted JSON body into a {@link DashboardTaskRequest}.
 *
 * Repo membership is checked separately against the workspace config.
 *
 * @param raw - Decoded JSON request body
 */
export function parseDashboardTaskRequest(raw: unknown): ParsedDashboardTaskRequest {
  if (!isRecord(raw)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const { repo, title, body, idempotencyKey } = raw;
  if (typeof repo !== "string" || !repo.trim()) {
    return { ok: false, error: "repo is required" };
  }
  if (typeof title !== "string" || !title.trim()) {
    return { ok: false, error: "title is required and cannot be empty" };
  }
  if (body !== undefined && typeof body !== "string") {
    return { ok: false, error: "body must be a string" };
  }
  const description = body ?? "";
  if (description.length > MAX_INJECTED_BODY_CHARS) {
    return {
      ok: false,
      error: `body is too large (${description.length} chars; maximum ${MAX_INJECTED_BODY_CHARS})`,
    };
  }
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return { ok: false, error: "idempotencyKey must be a non-empty string" };
    }
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      return {
        ok: false,
        error: `idempotencyKey is too long (maximum ${MAX_IDEMPOTENCY_KEY_CHARS} chars)`,
      };
    }
  }
  return {
    ok: true,
    request: {
      repo,
      title,
      body: description,
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
    },
  };
}

/**
 * Enqueue an ad-hoc task for a workspace repo.
 *
 * Returns 201 for a new task, 200 when an active task with the same
 * idempotency key was reused (`deduplicated: true`), 400 for an invalid body
 * or unknown repo, 409 when the dashboard has no usable workspace, and 500
 * when the prompt file or queue row could not be written.
 *
 * @param data - Dashboard data source (owns the workspace dir and queue store)
 * @param raw - Decoded JSON request body
 */
export function handleCreateTask(data: DashboardData, raw: unknown): ApiResponse {
  const load = loadDashboardWorkspaceConfig(workspaceConfigPath(data.workspaceDir));
  if (load.status === "missing") {
    return {
      status: 409,
      body: {
        error:
          "ad-hoc tasks need a worker workspace; this dashboard has none. " +
          "Run `devintern worker scaffold` and `devintern worker add-repo` first.",
      },
    };
  }
  if (load.status === "invalid") {
    return { status: 409, body: { error: `workspace config is invalid: ${load.error}` } };
  }
  const repos = load.config.repos.map((repo) => repo.name);
  if (repos.length === 0) {
    return {
      status: 409,
      body: { error: "no repos are configured in workspace.toml; run `devintern worker add-repo`" },
    };
  }

  const parsed = parseDashboardTaskRequest(raw);
  if (!parsed.ok) {
    return { status: 400, body: { error: parsed.error } };
  }
  const { request } = parsed;
  if (!repos.includes(request.repo)) {
    return {
      status: 400,
      body: { error: `unknown repo "${request.repo}"; valid repos: ${repos.join(", ")}` },
    };
  }

  try {
    const { task, deduplicated } = enqueueInjectedTask(
      data.getInjectedTaskStore(),
      data.workspaceDir,
      { ...request, actor: DASHBOARD_TASK_ACTOR },
    );
    const body: DashboardTaskResponse = {
      id: task.id,
      taskKey: task.taskKey,
      repo: task.repo,
      status: task.status,
      deduplicated,
    };
    return { status: deduplicated ? 200 : 201, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { error: `could not enqueue the task: ${message}` } };
  }
}
