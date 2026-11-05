/**
 * Workspace worker daemon fixture.
 *
 * Runs the real built CLI as a long-lived `devintern worker` subprocess against
 * a throwaway workspace: one local bare repository, a deterministic agent, and
 * no tracker credentials. The helper exposes the shared workspace queue so
 * tests can enqueue injected tasks and observe their rows without sleeping on a
 * fixed timer.
 */

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "./environment";
import { cliPath } from "./fixture-workspace";
import { checkedCommand } from "./process";

const packageRoot = resolve(import.meta.dir, "..");
const fixture = join(packageRoot, "fixtures/simple-project");

/** One row from the worker's durable injected-task queue. */
export interface WorkerInjectedTask {
  id: number;
  task_key: string;
  repo: string;
  title: string;
  body: string;
  status: "pending" | "running" | "done" | "failed";
  message: string | null;
  task_file: string;
  idempotency_key: string | null;
  actor: string;
  /** Automatic resumes consumed by startup recovery (`WORKER_INJECTED_AUTO_RESUME_LIMIT`). */
  auto_resume_count: number;
  /** Pid of the detached task child spawned for this row, or null when idle. */
  child_pid: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** Result of one built-CLI `worker add` invocation. */
export interface WorkerAddResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const INJECTED_COLUMNS = [
  "id",
  "task_key",
  "repo",
  "title",
  "body",
  "task_file",
  "idempotency_key",
  "actor",
  "status",
  "message",
  "auto_resume_count",
  "child_pid",
  "created_at",
  "started_at",
  "finished_at",
].join(", ");

/** Prefix of the per-harness usage-limit keys persisted in `webhook_meta`. */
const RATE_LIMIT_KEY_PREFIX = "rate_limit:";

/** Key of the persisted active harness in `webhook_meta`. */
const ACTIVE_HARNESS_KEY = "failover:active_harness";

/** One row from the worker's shared run-record table. */
export interface WorkerRunRecord {
  id: number;
  task_key: string | null;
  status: string;
  branch: string | null;
  repo: string | null;
  pr_url: string | null;
  outcome_reason: string | null;
  attempt: number | null;
}

export interface WorkerFixtureOptions {
  /** Global agent concurrency; defaults to one. */
  maxConcurrency?: number;
  /** Per-repository agent concurrency; defaults to one. */
  maxConcurrencyPerRepo?: number;
}

/** Log captured from the worker subprocess, for readiness and failure reports. */
interface OutputWaiter {
  pattern: RegExp;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Real workspace daemon backed by a local repository.
 *
 * Call {@link prepare}, enqueue tasks with {@link addTask}, then {@link start}
 * and {@link waitForReady}. Always call {@link dispose} in `finally` so the
 * daemon and temporary directories are released.
 */
export class WorkerFixture {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-worker-"));
  readonly workspaceDir = join(this.root, "workspace");
  readonly repoName = "fixture";
  readonly baseBranch = "e2e-base";
  readonly remote = join(this.root, "remote.git");
  readonly seed = join(this.root, "seed");
  readonly env = isolatedEnvironment(this.root);

  private child: ReturnType<typeof Bun.spawn> | null = null;
  private exitCode: number | undefined;
  private exitPromise: Promise<number> | null = null;
  private output = "";
  private readonly waiters = new Set<OutputWaiter>();

  constructor(private readonly options: WorkerFixtureOptions = {}) {
    this.env.DEVINTERN_WORKSPACE_DIR = this.workspaceDir;
    this.env.WEBHOOK_QUEUE_DB = this.dbPath;
    Object.assign(this.env, {
      WORKER_INJECTED_INTERVAL_SECONDS: "1",
      DEVINTERN_SKIP_LICENSE_CHECK: "1",
      DEVINTERN_NO_UPDATE: "1",
      DEVINTERN_TELEMETRY_DISABLED: "1",
      AGENT_HARNESS: "claude-code",
      AGENT_SANDBOX: "none",
    });
  }

  /** Shared workspace database (`<workspace>/state/queue.db`). */
  get dbPath(): string {
    return join(this.workspaceDir, "state", "queue.db");
  }

  /**
   * Workspace singleton lock (`<workspace>/.worker.lock`).
   *
   * The daemon writes `{ pid, timestamp }` here before starting acquirers; a
   * hard kill leaves it behind, so tests read its pid to target the crash and
   * assert the next daemon replaced it.
   */
  get lockFile(): string {
    return join(this.workspaceDir, ".worker.lock");
  }

  /** Pid recorded in the workspace lock, or undefined before/without a daemon. */
  daemonPid(): number | undefined {
    if (!existsSync(this.lockFile)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: unknown };
      return typeof parsed.pid === "number" ? parsed.pid : undefined;
    } catch {
      // A lock this process is writing right now is not valid JSON yet.
      return undefined;
    }
  }

  /** Complete stdout/stderr captured from the worker so far. */
  get logs(): string {
    return this.output;
  }

  /** Last captured log lines, for failure diagnostics. */
  tail(): string {
    const lines = this.output.trim().split("\n");
    return lines.slice(-80).join("\n");
  }

  /** Records written by the deterministic agent, one per invocation. */
  agentInvocations(): Array<{ mode: string }> {
    const path = this.env.E2E_AGENT_INVOCATIONS;
    if (!path || !existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { mode: string });
  }

  /**
   * Whether the daemon process is still running.
   *
   * `child.exitCode` is authoritative as soon as the process is reaped, even
   * before the `exited` callback records {@link exitCode}, so a daemon that
   * just died cannot be reported as running.
   */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.exitCode === undefined;
  }

  /**
   * Seed the local bare repository and write a credential-free workspace.
   *
   * The workspace deliberately has no task query, automation, estimation, or
   * error monitor. That is valid only while an injected task is pending, so
   * enqueue work before {@link start}: the worker then takes the documented
   * injection-only exception instead of exiting for lack of configured work.
   */
  async prepare(): Promise<void> {
    const agent = join(this.root, "agent.ts");
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
    chmodSync(agent, 0o700);
    this.env.AGENT_CLI_PATH = agent;
    this.env.E2E_AGENT_INVOCATIONS = join(this.root, "agent-invocations.jsonl");

    mkdirSync(this.workspaceDir, { recursive: true });
    writeFileSync(
      join(this.workspaceDir, "workspace.toml"),
      [
        "[workspace]",
        "dashboard = false",
        "",
        "[workspace.execution]",
        'isolation = "best_effort_host"',
        `max_concurrency = ${this.options.maxConcurrency ?? 1}`,
        `max_concurrency_per_repo = ${this.options.maxConcurrencyPerRepo ?? 1}`,
        "",
        "[defaults]",
        'tracker = "markdown"',
        'worker_task_args = "--create-pr --skip-clarity-check --skip-comments"',
        "",
        "[[repos]]",
        `name = "${this.repoName}"`,
        `remote = "${this.remote}"`,
        `default_branch = "${this.baseBranch}"`,
        "",
      ].join("\n"),
    );

    cpSync(fixture, this.seed, { recursive: true });
    await checkedCommand(
      ["git", "init", "--bare", "--initial-branch", this.baseBranch, this.remote],
      this.root,
      this.env,
    );
    const git = (...args: string[]) => checkedCommand(["git", ...args], this.seed, this.env);
    await git("init", "--initial-branch", this.baseBranch);
    await git("remote", "add", "origin", this.remote);
    await git("add", ".");
    await git("commit", "-m", "Seed worker fixture");
    await git("push", "--set-upstream", "origin", this.baseBranch);
  }

  /** Start the real worker daemon in its own process group. */
  start(): void {
    if (this.child) throw new Error("Worker fixture is already started");
    const child = Bun.spawn([process.execPath, cliPath, "worker"], {
      cwd: this.workspaceDir,
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    this.child = child;
    this.exitCode = undefined;
    this.output = "";
    void this.pump(child.stdout);
    void this.pump(child.stderr);
    this.exitPromise = child.exited.then((code) => {
      this.exitCode = code;
      this.rejectWaiters(
        new Error(`Worker exited with code ${code} before the expected log line\n${this.tail()}`),
      );
      return code;
    });
  }

  /**
   * Wait until the injected-task drain is armed.
   *
   * Readiness is a real daemon log line emitted after every acquirer has
   * started, not a fixed delay.
   */
  async waitForReady(timeoutMs = 20_000): Promise<void> {
    await this.waitForOutput(/Draining injected tasks every 1s/, timeoutMs, "worker readiness");
  }

  /**
   * Run the built CLI's `worker add` with arbitrary options.
   *
   * The default cwd is the fixture workspace; `stdin` is piped so
   * `--body-file -` can be exercised without a shell.
   */
  async runAdd(
    args: string[],
    options: { stdin?: string; cwd?: string; env?: Record<string, string> } = {},
  ): Promise<WorkerAddResult> {
    const child = Bun.spawn([process.execPath, cliPath, "worker", "add", ...args], {
      cwd: options.cwd ?? this.workspaceDir,
      env: { ...this.env, ...options.env },
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (options.stdin !== undefined) {
      const stdin = child.stdin;
      if (!stdin) throw new Error("worker add stdin pipe was not created");
      stdin.write(options.stdin);
      await stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  /** Enqueue one task through the built CLI and return its durable row. */
  async addTask(input: { title: string; body: string }): Promise<WorkerInjectedTask> {
    const result = await this.runAdd([
      "--repo",
      this.repoName,
      "--title",
      input.title,
      "--body",
      input.body,
      "--json",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`worker add exited ${result.exitCode}:\n${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout.trim()) as { id?: unknown };
    if (typeof parsed.id !== "number") {
      throw new Error(`worker add did not return a task id: ${result.stdout}`);
    }
    const task = this.injectedTask(parsed.id);
    if (!task) throw new Error(`Enqueued task #${parsed.id} was not readable from ${this.dbPath}`);
    return task;
  }

  /** Every injected-task row, oldest first, from a workspace queue DB. */
  injectedRows(dbPath: string = this.dbPath): WorkerInjectedTask[] {
    return this.query<WorkerInjectedTask>(
      `SELECT ${INJECTED_COLUMNS} FROM injected_tasks ORDER BY id`,
      [],
      dbPath,
    );
  }

  /** Find one injected-task row by task key and/or idempotency key. */
  findInjectedTask(
    input: { taskKey?: string; idempotencyKey?: string },
    dbPath: string = this.dbPath,
  ): WorkerInjectedTask | undefined {
    const conditions: string[] = [];
    const params: string[] = [];
    if (input.taskKey !== undefined) {
      conditions.push("task_key = ?");
      params.push(input.taskKey);
    }
    if (input.idempotencyKey !== undefined) {
      conditions.push("idempotency_key = ?");
      params.push(input.idempotencyKey);
    }
    if (conditions.length === 0) {
      throw new Error("findInjectedTask needs a taskKey or idempotencyKey");
    }
    return this.query<WorkerInjectedTask>(
      `SELECT ${INJECTED_COLUMNS} FROM injected_tasks WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT 1`,
      params,
      dbPath,
    )[0];
  }

  /**
   * Wait for an injected row to settle and return it with its run records.
   *
   * The run row is written before the queue row is finished, so a settled row
   * is enough to assert on the run without a second wait.
   */
  async waitForSettled(
    taskId: number,
    timeoutMs = 45_000,
  ): Promise<{ task: WorkerInjectedTask; runs: WorkerRunRecord[] }> {
    return await this.waitFor(
      `injected task #${taskId} to settle`,
      () => {
        const task = this.injectedTask(taskId);
        if (!task || (task.status !== "done" && task.status !== "failed")) return undefined;
        return { task, runs: this.runRecords(task.task_key) };
      },
      timeoutMs,
    );
  }

  /** Read one injected-task row, or undefined before the table exists. */
  injectedTask(id: number): WorkerInjectedTask | undefined {
    return this.query<WorkerInjectedTask>(
      `SELECT ${INJECTED_COLUMNS} FROM injected_tasks WHERE id = ?`,
      [id],
    )[0];
  }

  /** Read run records, optionally scoped to one task key. */
  runRecords(taskKey?: string): WorkerRunRecord[] {
    return taskKey === undefined
      ? this.query<WorkerRunRecord>(
          "SELECT id, task_key, status, branch, repo, pr_url, outcome_reason, attempt FROM runs ORDER BY id",
        )
      : this.query<WorkerRunRecord>(
          "SELECT id, task_key, status, branch, repo, pr_url, outcome_reason, attempt FROM runs WHERE task_key = ? ORDER BY id",
          [taskKey],
        );
  }

  /** Contents of a file on a branch in the local bare repository. */
  branchFile(branch: string, path: string): Promise<string> {
    return checkedCommand(
      ["git", "--git-dir", this.remote, "show", `refs/heads/${branch}:${path}`],
      this.root,
      this.env,
    );
  }

  /** Branch names currently pushed to the local bare repository. */
  async remoteBranches(): Promise<string[]> {
    const output = await checkedCommand(
      ["git", "--git-dir", this.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
      this.root,
      this.env,
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Persisted per-harness usage-limit windows (harness → epoch ms) from the
   * queue's `webhook_meta` table, read through the same read-only pattern as
   * the other queue queries.
   *
   * @param dbPath - Workspace queue database; defaults to this fixture's.
   */
  rateLimits(dbPath: string = this.dbPath): Record<string, number> {
    const rows = this.query<{ key: string; value: string }>(
      `SELECT key, value FROM webhook_meta WHERE key LIKE '${RATE_LIMIT_KEY_PREFIX}%'`,
      [],
      dbPath,
    );
    const limits: Record<string, number> = {};
    for (const row of rows) {
      const untilMs = Number(row.value);
      if (Number.isFinite(untilMs)) {
        limits[row.key.slice(RATE_LIMIT_KEY_PREFIX.length)] = untilMs;
      }
    }
    return limits;
  }

  /**
   * Persisted active harness from `webhook_meta`, or undefined before failover
   * has written one.
   *
   * @param dbPath - Workspace queue database; defaults to this fixture's.
   */
  activeHarness(dbPath: string = this.dbPath): string | undefined {
    return this.query<{ value: string }>(
      "SELECT value FROM webhook_meta WHERE key = ?",
      [ACTIVE_HARNESS_KEY],
      dbPath,
    )[0]?.value;
  }

  /** Non-base task worktrees left under the repo's workspace directory. */
  taskWorktrees(): string[] {
    const dir = join(this.workspaceDir, "worktrees", this.repoName);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((entry) => entry !== "base");
  }

  /** Poll a synchronous probe until it returns a value; never only sleep. */
  async waitFor<T>(
    label: string,
    probe: () => T | undefined,
    timeoutMs = 30_000,
    intervalMs = 100,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // A daemon that already exited can never settle the wait; fail fast with
      // its logs instead of blocking until the deadline.
      this.assertRunning(label);
      const value = probe();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\n${this.tail()}`);
      }
      await Bun.sleep(intervalMs);
    }
  }

  /** Wait for a log pattern with a bounded timeout and fail fast on exit. */
  async waitForOutput(pattern: RegExp, timeoutMs = 20_000, label = "log line"): Promise<void> {
    if (pattern.test(this.output)) return;
    this.assertRunning(label);
    await new Promise<void>((resolve, reject) => {
      const waiter: OutputWaiter = {
        pattern,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\n${this.tail()}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** SIGTERM the daemon, wait for a graceful exit, then force-kill its group. */
  async stop(timeoutMs = 25_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.exitCode === undefined) {
      this.signal("SIGTERM");
      if (!(await this.waitForExit(timeoutMs))) {
        this.signal("SIGKILL");
        if (!(await this.waitForExit(5_000))) {
          throw new Error(`Worker process did not exit after SIGKILL\n${this.tail()}`);
        }
      }
    }
    await this.exitPromise?.catch(() => undefined);
    this.child = null;
  }

  /**
   * Simulate a hard crash (`kill -9`/power loss) of the daemon.
   *
   * SIGKILLs the daemon's process group so no shutdown hook runs: a claimed
   * injected row stays `running` and its run stays `in_progress` for the next
   * daemon's startup recovery. The task child is spawned detached and therefore
   * leads its own process group, so it survives; callers must kill it (and the
   * agent it leads) with {@link killProcessTree} using the row's `child_pid`.
   *
   * The fixture's child handle is released, so {@link start} can relaunch the
   * daemon without an intervening {@link stop}.
   *
   * @returns The daemon pid that was killed
   */
  async crash(timeoutMs = 10_000): Promise<number> {
    const pid = this.daemonPid() ?? this.child?.pid;
    if (pid === undefined) {
      throw new Error("Worker fixture has no running daemon to crash");
    }
    killProcessGroup(pid, "SIGKILL");
    if (!(await this.waitForExit(timeoutMs))) {
      throw new Error(`Worker process ${pid} did not exit after SIGKILL\n${this.tail()}`);
    }
    await this.exitPromise?.catch(() => undefined);
    this.child = null;
    return pid;
  }

  /** Stop the daemon and remove every temporary path. */
  async dispose(): Promise<void> {
    try {
      await this.stop();
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  /**
   * Throw when the daemon has already exited.
   *
   * Both sources are consulted: {@link exitCode} is recorded asynchronously by
   * the `exited` handler, while the subprocess's own `exitCode` flips as soon
   * as the process is reaped.
   */
  private assertRunning(label: string): void {
    const exitCode = this.exitCode ?? this.child?.exitCode ?? undefined;
    if (exitCode === undefined) return;
    throw new Error(
      `Worker exited with code ${exitCode} while waiting for ${label}\n${this.tail()}`,
    );
  }

  /** Run a read-only queue query, tolerating a database that is still absent. */
  private query<T>(sql: string, params: Array<string | number> = [], dbPath = this.dbPath): T[] {
    if (!existsSync(dbPath)) return [];
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      return db.query(sql).all(...params) as T[];
    } catch {
      // The worker may be between schema creation and its first write.
      return [];
    } finally {
      db?.close();
    }
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.append(decoder.decode(value, { stream: true }));
      }
      this.append(decoder.decode());
    } catch (error) {
      this.append(`\n[e2e] worker log stream failed: ${(error as Error).message}\n`);
    } finally {
      reader.releaseLock();
    }
  }

  private append(chunk: string): void {
    if (!chunk) return;
    this.output += chunk;
    for (const waiter of this.waiters) {
      if (!waiter.pattern.test(this.output)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const exited = this.child?.exited;
    if (!exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    });
    try {
      return await Promise.race([exited.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      // Bun spawned the daemon detached, so the pid is also its process group.
      process.kill(-pid, signal);
    } catch {
      try {
        this.child?.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Signal a pid's process group, falling back to the pid alone.
 *
 * Never throws: the target may have exited between the caller's check and the
 * signal (a normal race when cleaning up after a killed daemon).
 *
 * @param pid - Process (and process-group) id to signal
 * @param signal - Signal to send, defaults to an unblockable `SIGKILL`
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Whether a pid names a live, runnable process.
 *
 * A zombie awaiting its parent's `wait()` still answers `kill(pid, 0)` but can
 * never do work again, so it counts as gone. `ps` is read the same way the
 * product probes interrupted task children.
 *
 * @param pid - Process id to probe
 */
export function isProcessRunning(pid: number): boolean {
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return stat.length > 0 && !stat.startsWith("Z");
  } catch {
    return false;
  }
}

/** Every live descendant of `root`, read once from the process table. */
function processDescendants(root: number): number[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    return [];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(root) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

/**
 * Kill a task child, its process group and every descendant, returning the
 * pids that were signalled.
 *
 * The worker spawns each task child detached (its own process group), but the
 * agent harness spawns the agent detached as well. Signalling only the task
 * child's group would therefore leave the deterministic agent sleeping for the
 * fixture's delay; snapshotting descendants first kills the whole attempt.
 *
 * @param pid - Recorded `child_pid` of a task row
 * @param signal - Signal to send, defaults to an unblockable `SIGKILL`
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): number[] {
  const pids = [pid, ...processDescendants(pid)];
  for (const target of pids) killProcessGroup(target, signal);
  return pids;
}

/**
 * Poll until every pid is gone.
 *
 * @param pids - Pids to watch
 * @param timeoutMs - Bounded wait; never sleeps a fixed time before the first probe
 * @returns The pids still running at the deadline (empty on success)
 */
export async function waitForProcessesGone(
  pids: readonly number[],
  timeoutMs = 10_000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter((pid) => isProcessRunning(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    alive = alive.filter((pid) => isProcessRunning(pid));
  }
  return alive;
}

export { cliPath };
