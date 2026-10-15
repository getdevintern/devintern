/**
 * `devintern worker add` — enqueue a one-off task against a workspace repo.
 *
 * Materializes the caller's title/body as a local markdown task file, then
 * inserts a durable row into the workspace DB so the running worker picks it
 * up on its next poll and runs it through the normal pipeline (checkout,
 * agent, PR). No tracker ticket is required, and the repo is named explicitly
 * so `[[routing.rules]]` are not consulted.
 *
 * Non-interactive by default: returns after enqueue. `--wait` blocks until
 * the run settles and exits with its success/failure status; `--json` emits a
 * single machine-readable object on stdout (human diagnostics go to stderr).
 */

import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

import { checkLicense } from "@devintern/license-check";

import { LockManager } from "../lock-manager";
import { loadSupabaseConfig } from "../cli/bootstrap";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { loadWorkspaceConfig } from "./config";
import { InjectedTaskStore } from "../state/injected-tasks";
import type { EnqueueInjectedTaskResult, InjectedTask } from "../state/injected-tasks";
import { RunStore } from "../state/run-recorder";
import type { RunRecord } from "../state/run-recorder";
import { applyWorkspaceProcessEnv } from "./env";
import {
  injectedTasksDir,
  resolveWorkspaceDir,
  workspaceCodeStateDir,
  workspaceConfigPath,
  workspaceDbPath,
} from "./paths";

/** Maximum body size accepted (matches the run recorder's description cap). */
export const MAX_INJECTED_BODY_CHARS = 20_000;

/** How often `--wait` re-reads the task row. */
const WAIT_POLL_INTERVAL_MS = 1_000;

/**
 * Default `--wait` deadline (`--wait-timeout`), in seconds.
 *
 * A settled row and a disappeared worker are the fast exits, but a live worker
 * can keep deferring a row forever — a usage-limit pause or a permanently
 * saturated repo requeues the task every tick without progress. The deadline
 * bounds `--wait` so it cannot hang indefinitely; `--wait-timeout 0` opts back
 * into waiting without a limit.
 */
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 6 * 60 * 60;

export interface WorkerAddOptions {
  /** Human-readable status sink (defaults to stdout). */
  log?: (message: string) => void;
  /** Failure sink (defaults to stderr). */
  error?: (message: string) => void;
  /** Reads stdin for `--body-file -`; injectable for tests. */
  readStdin?: () => string;
}

export interface AddOptions {
  workspacePath?: string;
  repo?: string;
  title: string;
  body?: string;
  bodyFile?: string;
  idempotencyKey?: string;
  wait: boolean;
  json: boolean;
  /** `--wait` deadline in seconds; `0` waits without a limit (default 6h). */
  waitTimeoutSeconds?: number;
}

export type ParsedAddArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; options: AddOptions };

function usage(): string {
  return [
    "Usage: devintern worker add --title <text> [--repo <name>] [options]",
    "",
    "Enqueue a one-off task against a workspace repo without a tracker ticket.",
    "The running worker runs it through the normal pipeline (checkout, agent,",
    "PR) on its next poll.",
    "",
    "Options:",
    "  --title <text>            Task title (required)",
    "  --repo <name>             [[repos]] name to target (default: the only repo)",
    "  --body <text>             Task description",
    "  --body-file <path>        Read the description from a file ('-' for stdin)",
    "  --idempotency-key <key>   Dedupe key; a retry reuses the existing task",
    "  --wait                    Block until the run finishes; exit with its status",
    "  --wait-timeout <seconds>  Give up waiting after this long (0 = no limit; default 21600)",
    "  --json                    Emit a machine-readable result on stdout",
    "  --workspace <path>        Use this workspace.toml (default: ~/.devintern/)",
    "  -h, --help                Show this help",
  ].join("\n");
}

/** Flag names that require a following value. */
const VALUE_FLAGS = new Set([
  "--workspace",
  "--repo",
  "--title",
  "--body",
  "--body-file",
  "--idempotency-key",
  "--wait-timeout",
]);

/**
 * Parse `worker add` arguments. Kept separate from execution so help and arg
 * errors are testable without touching a workspace.
 */
export function parseWorkerAddArgs(args: string[]): ParsedAddArgs {
  const options: AddOptions = { title: "", wait: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--wait") {
      options.wait = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      // `--body-file -` is the documented stdin sentinel; other flags reject
      // a leading dash so a forgotten value cannot swallow the next flag.
      const allowDash = arg === "--body-file";
      if (value === undefined || (!allowDash && value.startsWith("-"))) {
        return { kind: "error", message: `${arg} requires a value.` };
      }
      i++;
      switch (arg) {
        case "--workspace":
          options.workspacePath = value;
          break;
        case "--repo":
          options.repo = value;
          break;
        case "--title":
          options.title = value;
          break;
        case "--body":
          options.body = value;
          break;
        case "--body-file":
          options.bodyFile = value;
          break;
        case "--idempotency-key":
          options.idempotencyKey = value;
          break;
        case "--wait-timeout": {
          const seconds = Number(value);
          if (!Number.isInteger(seconds) || seconds < 0) {
            return {
              kind: "error",
              message: "--wait-timeout requires a non-negative integer number of seconds.",
            };
          }
          options.waitTimeoutSeconds = seconds;
          break;
        }
      }
      continue;
    }
    return { kind: "error", message: `Unknown option: ${arg}` };
  }

  if (!options.title.trim()) {
    return { kind: "error", message: "--title is required and cannot be empty." };
  }
  if (options.body !== undefined && options.bodyFile !== undefined) {
    return { kind: "error", message: "--body and --body-file are mutually exclusive." };
  }
  if (options.idempotencyKey !== undefined && !options.idempotencyKey.trim()) {
    return { kind: "error", message: "--idempotency-key cannot be empty." };
  }
  return { kind: "ok", options };
}

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

function displayPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

type BodyResolution = { ok: true; body: string } | { ok: false };
type RepoResolution = { ok: true; repo: RepoConfig } | { ok: false; code: number };

/** Resolve the target repo, or explain how to fix an unknown/ambiguous name. */
function resolveTargetRepo(
  config: WorkspaceConfig,
  requested: string | undefined,
  error: (message: string) => void,
): RepoResolution {
  const names = config.repos.map((repo) => repo.name);
  if (requested) {
    const repo = config.repos.find((candidate) => candidate.name === requested);
    if (repo) return { ok: true, repo };
    error(`❌ Unknown repo "${requested}".`);
    error(`   Valid repos: ${names.join(", ")}`);
    return { ok: false, code: 1 };
  }
  const [onlyRepo] = config.repos;
  if (config.repos.length === 1 && onlyRepo) {
    return { ok: true, repo: onlyRepo };
  }
  error("❌ --repo is required because this workspace has multiple repos.");
  error(`   Valid repos: ${names.join(", ")}`);
  return { ok: false, code: 1 };
}

/** Read and validate the task body (inline, file, or stdin). */
function resolveInjectedBody(
  add: AddOptions,
  options: WorkerAddOptions,
  error: (message: string) => void,
): BodyResolution {
  let body = add.body ?? "";
  if (add.bodyFile !== undefined) {
    try {
      body =
        add.bodyFile === "-"
          ? (options.readStdin ?? readStdin)()
          : readFileSync(add.bodyFile, "utf8");
    } catch (readError) {
      error(`❌ Could not read --body-file ${add.bodyFile}: ${(readError as Error).message}`);
      return { ok: false };
    }
  }
  if (body.length > MAX_INJECTED_BODY_CHARS) {
    error(`❌ Body is too large (${body.length} chars; maximum ${MAX_INJECTED_BODY_CHARS}).`);
    error("   Move long context into the repo or link it from the title.");
    return { ok: false };
  }
  return { ok: true, body };
}

/**
 * Enforce the same automation entitlement the worker daemon requires, and
 * report the outcome with the daemon's wording.
 */
async function checkAutomationAccess(
  selectedDir: string,
  log: (message: string) => void,
  error: (message: string) => void,
): Promise<boolean> {
  applyWorkspaceProcessEnv(selectedDir);
  const licenseResult = await checkLicense({
    productKey: "devintern/code",
    supabaseConfig: loadSupabaseConfig(workspaceCodeStateDir(selectedDir)),
    requireAutomation: true,
    allowTrial: true,
  });
  if (!licenseResult.valid) {
    error("❌ License check failed");
    error(`   ${licenseResult.message}`);
    return false;
  }
  if (licenseResult.source === "grace") log(`⚠️  ${licenseResult.message}`);
  else if (licenseResult.source === "trial") log(`⏳ ${licenseResult.message}`);
  else if (licenseResult.source === "license-key" || licenseResult.source === "entitlement") {
    log(`✅ ${licenseResult.message}`);
  }
  return true;
}

/**
 * Enqueue a one-off task for a workspace repo.
 *
 * @returns Process exit code (0 on enqueue, or the run's status with `--wait`).
 */
export async function runWorkerAdd(
  args: string[],
  options: WorkerAddOptions = {},
): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const error = options.error ?? ((message: string) => console.error(message));

  const parsed = parseWorkerAddArgs(args);
  if (parsed.kind === "help") {
    log(usage());
    return 0;
  }
  if (parsed.kind === "error") {
    error(`❌ ${parsed.message}`);
    error("   Run `devintern worker add --help` for usage.");
    return 1;
  }
  const { options: add } = parsed;

  // With `--json`, stdout is reserved for the single result object: route every
  // human/status diagnostic (license line, "Enqueued…", the `--wait` spinner)
  // to stderr so `devintern worker add … --json | jq .` parses cleanly.
  const status = add.json ? error : log;

  const selectedDir = add.workspacePath
    ? dirname(resolve(add.workspacePath))
    : resolveWorkspaceDir();
  const configPath = add.workspacePath
    ? resolve(add.workspacePath)
    : workspaceConfigPath(selectedDir);
  if (!existsSync(configPath)) {
    error(`❌ No workspace.toml at ${configPath}.`);
    error("   Run `devintern worker scaffold` first, then `devintern worker add-repo`.");
    return 1;
  }

  let config: WorkspaceConfig;
  try {
    config = loadWorkspaceConfig(configPath);
  } catch (loadError) {
    error(`❌ Could not read ${configPath}: ${(loadError as Error).message}`);
    return 1;
  }
  if (config.repos.length === 0) {
    error(`❌ No repos configured in ${configPath}.`);
    error("   Run `devintern worker add-repo` inside a checkout first.");
    return 1;
  }

  const repoResult = resolveTargetRepo(config, add.repo, error);
  if (!repoResult.ok) return repoResult.code;
  const repo = repoResult.repo;

  const bodyResult = resolveInjectedBody(add, options, error);
  if (!bodyResult.ok) return 1;
  const body = bodyResult.body;

  if (!(await checkAutomationAccess(selectedDir, status, error))) return 1;

  const workerRunning =
    LockManager.readLockStatus(selectedDir, ".worker.lock", { plainDir: true })?.running ?? false;
  if (!workerRunning && add.wait) {
    error("❌ --wait needs a running worker, but none is active for this workspace.");
    error("   Start it with `devintern worker`, or drop --wait to enqueue durably.");
    return 1;
  }

  const store = new InjectedTaskStore(workspaceDbPath(selectedDir));
  try {
    if (add.idempotencyKey) {
      // Only an active (pending/running) task dedupes; a settled one under the
      // same key is history and a new occurrence is enqueued below.
      const existing = store.findActiveByIdempotencyKey(add.idempotencyKey);
      if (existing) {
        // `await` is load-bearing: without it the surrounding `finally` would
        // `store.close()` while `reportTask`/`waitForTask` is still polling.
        return await reportTask(existing, {
          log,
          error,
          status,
          wait: add.wait,
          json: add.json,
          waitTimeoutSeconds: add.waitTimeoutSeconds,
          store,
          selectedDir,
        });
      }
    }
    return await enqueueNewTask(add, body, repo, {
      store,
      selectedDir,
      workerRunning,
      log,
      error,
      status,
      wait: add.wait,
      json: add.json,
      waitTimeoutSeconds: add.waitTimeoutSeconds,
    });
  } finally {
    store.close();
  }
}

/** Shared sinks + task state threaded through the enqueue/report/wait paths. */
interface TaskContext {
  log: (message: string) => void;
  error: (message: string) => void;
  /** Human/status sink: stderr under `--json`, else stdout. */
  status: (message: string) => void;
  wait: boolean;
  json: boolean;
  /** `--wait` deadline in seconds; `0` = no limit, undefined = the default. */
  waitTimeoutSeconds?: number;
  store: InjectedTaskStore;
  selectedDir: string;
}

/** A per-invocation filename so concurrent callers never share a prompt path. */
function injectedTaskFileName(taskKey: string): string {
  return `${taskKey}-${randomBytes(4).toString("hex")}.md`;
}

/** Whether an insert failed on the `task_key` unique index (lost a key race). */
function isTaskKeyConflict(error: unknown): boolean {
  return /UNIQUE constraint failed: injected_tasks\.task_key/i.test(String(error));
}

/** Bound the re-derive/retry loop if many callers race the same title. */
const MAX_TASK_KEY_ATTEMPTS = 50;

/** Create the markdown file + durable row, then optionally wait. */
async function enqueueNewTask(
  add: AddOptions,
  body: string,
  repo: RepoConfig,
  ctx: TaskContext & { workerRunning: boolean },
): Promise<number> {
  const { store, selectedDir, workerRunning, log, status } = ctx;
  const dir = injectedTasksDir(selectedDir);
  // Prompts hold arbitrary operator context, so keep them owner-only like the
  // workspace .env. `mode` only applies to newly created paths.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt++) {
    const taskKey = deriveInjectedTaskKey(add.title, (key) => store.hasTaskKey(key));
    // Unique per call: if a concurrent caller wins the same key or idempotency
    // row, unlinking our own file can never delete the winner's prompt.
    const taskFile = join(dir, injectedTaskFileName(taskKey));
    writeFileSync(taskFile, buildInjectedTaskMarkdown({ taskKey, title: add.title, body }), {
      encoding: "utf8",
      mode: 0o600,
    });

    let enqueued: EnqueueInjectedTaskResult;
    try {
      enqueued = store.enqueue({
        taskKey,
        repo: repo.name,
        title: add.title.trim(),
        body,
        taskFile,
        idempotencyKey: add.idempotencyKey,
        actor: "local:add",
      });
    } catch (enqueueError) {
      try {
        unlinkSync(taskFile);
      } catch {
        // Best-effort cleanup.
      }
      // A concurrent caller claimed this task_key first; re-derive (now seeing
      // their committed row) and retry with a suffixed key.
      if (isTaskKeyConflict(enqueueError) && attempt < MAX_TASK_KEY_ATTEMPTS) continue;
      throw enqueueError;
    }

    const { task, deduplicated } = enqueued;
    if (deduplicated) {
      // Lost an idempotency race: drop our own file and report their row.
      try {
        unlinkSync(taskFile);
      } catch {
        // Best-effort cleanup.
      }
      return reportTask(task, ctx);
    }

    if (!add.json) {
      status(`✅ Enqueued ${task.taskKey} for repo "${task.repo}" (task #${task.id}).`);
      status(
        workerRunning
          ? "   The worker picks it up on its next poll."
          : "⚠️  No worker is running; the task stays queued until one starts.",
      );
      status(`   Prompt: ${displayPath(task.taskFile)}`);
    }

    if (!add.wait) {
      if (add.json) log(JSON.stringify({ ...serialize(task), deduplicated: false }));
      return 0;
    }
    return await waitForTask(task.id, { ...ctx, deduplicated: false, taskKey: task.taskKey });
  }
}

function serialize(task: InjectedTask): {
  id: number;
  taskKey: string;
  repo: string;
  status: string;
} {
  return { id: task.id, taskKey: task.taskKey, repo: task.repo, status: task.status };
}

/**
 * Emit the single result for a settled task: the JSON object under `--json`,
 * otherwise a human success/failure line. Returns the process exit code.
 */
function emitSettled(task: InjectedTask, deduplicated: boolean, ctx: TaskContext): number {
  if (ctx.json) {
    ctx.log(JSON.stringify({ ...serialize(task), deduplicated }));
  } else if (task.status === "failed") {
    ctx.error(`❌ ${task.taskKey} failed${task.message ? `: ${task.message}` : ""}`);
  } else {
    ctx.log(`✅ ${task.taskKey} finished.`);
  }
  return task.status === "failed" ? 1 : 0;
}

/** Report an existing (idempotent) task, waiting on it when requested. */
async function reportTask(task: InjectedTask, ctx: TaskContext): Promise<number> {
  if (!ctx.json) {
    ctx.status(
      `ℹ️  Idempotency key already used by ${task.taskKey} (task #${task.id}, status: ${task.status}).`,
    );
  }
  if (!ctx.wait) {
    if (ctx.json) ctx.log(JSON.stringify({ ...serialize(task), deduplicated: true }));
    return 0;
  }
  if (task.status === "done" || task.status === "failed") {
    return emitSettled(task, true, ctx);
  }
  return await waitForTask(task.id, { ...ctx, deduplicated: true, taskKey: task.taskKey });
}

/**
 * Emit the terminal result for a `--wait` failure that never observed a settled
 * row (timeout, worker stopped, or an inconclusive pruned row). Under `--json`
 * stdout still carries exactly one object — the documented `… | jq .` contract
 * holds on failures too — with `status: "failed"`; the human diagnostics stay
 * on stderr. Returns the failure exit code.
 */
function failWait(
  ctx: TaskContext & { deduplicated: boolean; taskKey: string },
  result: { id: number; repo?: string; error: string },
  errorLines: readonly string[],
): number {
  for (const line of errorLines) {
    ctx.error(line);
  }
  if (ctx.json) {
    ctx.log(
      JSON.stringify({
        id: result.id,
        taskKey: ctx.taskKey,
        repo: result.repo ?? "",
        status: "failed",
        deduplicated: ctx.deduplicated,
        error: result.error,
      }),
    );
  }
  return 1;
}

/**
 * Poll a task row until it settles and emit exactly one result. Fails fast when
 * the worker disappears, and again when the `--wait-timeout` deadline elapses
 * with the row still unsettled, so `--wait` cannot hang forever. The interim
 * "pending" JSON is intentionally not emitted: with `--wait --json` stdout
 * carries a single object describing the final state (including these
 * failures, which are reported as a terminal `status: "failed"` object).
 */
async function waitForTask(
  id: number,
  ctx: TaskContext & { deduplicated: boolean; taskKey: string },
): Promise<number> {
  ctx.status(`⏳ Waiting for task #${id} to finish (Ctrl-C to detach)...`);
  const timeoutSeconds = ctx.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1_000 : Infinity;
  for (;;) {
    const task = ctx.store.getById(id);
    if (!task) {
      return reportPrunedTask(id, ctx);
    }
    if (task.status === "done" || task.status === "failed") {
      return emitSettled(task, ctx.deduplicated, ctx);
    }
    if (Date.now() >= deadline) {
      return failWait(
        ctx,
        {
          id,
          repo: task.repo,
          error: `Timed out after ${timeoutSeconds}s waiting for task #${id} (still ${task.status}).`,
        },
        [
          `❌ Timed out after ${timeoutSeconds}s waiting for task #${id} (still ${task.status}).`,
          "   It remains queued/running; check the worker dashboard, or raise --wait-timeout (0 disables it).",
        ],
      );
    }
    const workerRunning =
      LockManager.readLockStatus(ctx.selectedDir, ".worker.lock", { plainDir: true })?.running ??
      false;
    if (!workerRunning) {
      return failWait(
        ctx,
        { id, repo: task.repo, error: "The worker stopped before the task finished." },
        [
          "❌ The worker stopped before the task finished; it remains queued/failed.",
          "   Start the worker again and inspect the dashboard run history.",
        ],
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, WAIT_POLL_INTERVAL_MS));
  }
}

/**
 * Report a task whose injected row was pruned by the worker's retention sweep
 * before `--wait` observed its terminal status.
 *
 * `pruneSettled` only removes settled (`done`/`failed`) rows, so a row that
 * vanished after the CLI enqueued it settled; its outcome is durably mirrored
 * in the run record (same DB, keyed by the task key) written before the row is
 * finished. Read that instead of reporting a spurious "disappeared" failure
 * for a successful run. A missing or non-terminal run (e.g. the DB was edited
 * out from under us) is genuinely inconclusive and still fails.
 */
function reportPrunedTask(
  id: number,
  ctx: TaskContext & { deduplicated: boolean; taskKey: string },
): number {
  const run = readLatestRun(ctx.selectedDir, ctx.taskKey);
  if (!run || run.status === "in_progress" || run.status === "deferred") {
    return failWait(ctx, { id, error: `Injected task #${id} disappeared while waiting.` }, [
      `❌ Injected task #${id} disappeared while waiting.`,
    ]);
  }
  const settled: InjectedTask = {
    id,
    taskKey: ctx.taskKey,
    repo: run.repo ?? "",
    title: "",
    body: "",
    taskFile: "",
    actor: "",
    status: run.status === "succeeded" ? "done" : "failed",
    message: run.outcomeReason,
    createdAt: run.startedAt,
  };
  if (!ctx.json) {
    ctx.status(`ℹ️  Injected task #${id} was pruned after it settled; reporting its run outcome.`);
  }
  return emitSettled(settled, ctx.deduplicated, ctx);
}

/** Latest run record for a task key (read-only; null when absent/unreadable). */
function readLatestRun(selectedDir: string, taskKey: string): RunRecord | null {
  let store: RunStore | null = null;
  try {
    store = new RunStore(workspaceDbPath(selectedDir), { readonly: true });
    return store.latestRunByTaskKey([taskKey]).get(taskKey) ?? null;
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/** Read all of stdin (used by `--body-file -`). */
function readStdin(): string {
  return readFileSync(0, "utf8");
}
