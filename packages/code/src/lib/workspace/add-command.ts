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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

import { checkLicense } from "@devintern/license-check";

import { LockManager } from "../lock-manager";
import { loadSupabaseConfig } from "../cli/bootstrap";
import type { RepoConfig, WorkspaceConfig } from "./config";
import { loadWorkspaceConfig } from "./config";
import { InjectedTaskStore } from "../state/injected-tasks";
import type { InjectedTask } from "../state/injected-tasks";
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

  if (!(await checkAutomationAccess(selectedDir, log, error))) return 1;

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
      const existing = store.findByIdempotencyKey(add.idempotencyKey);
      if (existing) {
        return reportTask(existing, {
          log,
          error,
          wait: add.wait,
          json: add.json,
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
    });
  } finally {
    store.close();
  }
}

/** Create the markdown file + durable row, then optionally wait. */
async function enqueueNewTask(
  add: AddOptions,
  body: string,
  repo: RepoConfig,
  ctx: {
    store: InjectedTaskStore;
    selectedDir: string;
    workerRunning: boolean;
    log: (message: string) => void;
    error: (message: string) => void;
  },
): Promise<number> {
  const { store, selectedDir, workerRunning, log, error } = ctx;
  const taskKey = deriveInjectedTaskKey(add.title, (key) => store.hasTaskKey(key));
  const dir = injectedTasksDir(selectedDir);
  mkdirSync(dir, { recursive: true });
  const taskFile = join(dir, `${taskKey}.md`);
  writeFileSync(taskFile, buildInjectedTaskMarkdown({ taskKey, title: add.title, body }), "utf8");

  const { task, deduplicated } = store.enqueue({
    taskKey,
    repo: repo.name,
    title: add.title.trim(),
    body,
    taskFile,
    idempotencyKey: add.idempotencyKey,
    actor: "local:add",
  });
  if (deduplicated) {
    // Lost a race with a concurrent caller: drop the file we just wrote and
    // report the row they created.
    try {
      unlinkSync(taskFile);
    } catch {
      // Best-effort cleanup.
    }
    return reportTask(task, {
      log,
      error,
      wait: add.wait,
      json: add.json,
      store,
      selectedDir,
    });
  }

  if (add.json) {
    log(JSON.stringify({ ...serialize(task), deduplicated: false }));
  } else {
    log(`✅ Enqueued ${task.taskKey} for repo "${task.repo}" (task #${task.id}).`);
    log(
      workerRunning
        ? "   The worker picks it up on its next poll."
        : "⚠️  No worker is running; the task stays queued until one starts.",
    );
    log(`   Prompt: ${displayPath(task.taskFile)}`);
  }

  if (!add.wait) return 0;
  return await waitForTask(task.id, { store, selectedDir, log, error, json: add.json });
}

function serialize(task: InjectedTask): {
  id: number;
  taskKey: string;
  repo: string;
  status: string;
} {
  return { id: task.id, taskKey: task.taskKey, repo: task.repo, status: task.status };
}

/** Report an existing (idempotent) task, waiting on it when requested. */
async function reportTask(
  task: InjectedTask,
  ctx: {
    log: (message: string) => void;
    error: (message: string) => void;
    wait: boolean;
    json: boolean;
    store: InjectedTaskStore;
    selectedDir: string;
  },
): Promise<number> {
  if (ctx.json) {
    ctx.log(JSON.stringify({ ...serialize(task), deduplicated: true }));
  } else {
    ctx.log(
      `ℹ️  Idempotency key already used by ${task.taskKey} (task #${task.id}, status: ${task.status}).`,
    );
  }
  if (!ctx.wait) return 0;
  if (task.status === "done") return 0;
  if (task.status === "failed") return 1;
  return await waitForTask(task.id, {
    store: ctx.store,
    selectedDir: ctx.selectedDir,
    log: ctx.log,
    error: ctx.error,
    json: ctx.json,
  });
}

/**
 * Poll a task row until it settles. Fails fast when the worker disappears, so
 * `--wait` cannot hang forever after the daemon exits.
 */
async function waitForTask(
  id: number,
  ctx: {
    store: InjectedTaskStore;
    selectedDir: string;
    log: (message: string) => void;
    error: (message: string) => void;
    json: boolean;
  },
): Promise<number> {
  ctx.log(`⏳ Waiting for task #${id} to finish (Ctrl-C to detach)...`);
  for (;;) {
    const task = ctx.store.getById(id);
    if (!task) {
      ctx.error(`❌ Injected task #${id} disappeared while waiting.`);
      return 1;
    }
    if (task.status === "done") {
      if (ctx.json) ctx.log(JSON.stringify({ ...serialize(task), deduplicated: false }));
      else ctx.log(`✅ ${task.taskKey} finished.`);
      return 0;
    }
    if (task.status === "failed") {
      if (ctx.json) ctx.log(JSON.stringify({ ...serialize(task), deduplicated: false }));
      else ctx.error(`❌ ${task.taskKey} failed${task.message ? `: ${task.message}` : ""}`);
      return 1;
    }
    const workerRunning =
      LockManager.readLockStatus(ctx.selectedDir, ".worker.lock", { plainDir: true })?.running ??
      false;
    if (!workerRunning) {
      ctx.error("❌ The worker stopped before the task finished; it remains queued/failed.");
      ctx.error("   Start the worker again and inspect the dashboard run history.");
      return 1;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, WAIT_POLL_INTERVAL_MS));
  }
}

/** Read all of stdin (used by `--body-file -`). */
function readStdin(): string {
  return readFileSync(0, "utf8");
}
