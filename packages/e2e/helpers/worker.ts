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
  "created_at",
  "started_at",
  "finished_at",
].join(", ");

/** Serialize one scheduled automation as a TOML `[[automations]]` table. */
function automationTable(automation: WorkerAutomation): string[] {
  const lines = [
    "[[automations]]",
    `id = ${JSON.stringify(automation.id)}`,
    `enabled = ${automation.enabled ?? true}`,
  ];
  if (automation.interval !== undefined) {
    lines.push(`interval = ${JSON.stringify(automation.interval)}`);
  } else {
    lines.push(`cron = ${JSON.stringify(automation.cron ?? "* * * * *")}`);
  }
  lines.push(`prompt = ${JSON.stringify(automation.prompt)}`);
  if (automation.repo !== undefined) lines.push(`repo = ${JSON.stringify(automation.repo)}`);
  if (automation.openPr !== undefined) lines.push(`open_pr = ${automation.openPr}`);
  if (automation.allowNoChanges !== undefined) {
    lines.push(`allow_no_changes = ${automation.allowNoChanges}`);
  }
  return lines;
}

/** Prefix of the per-harness usage-limit keys persisted in `webhook_meta`. */
const RATE_LIMIT_KEY_PREFIX = "rate_limit:";

/** Key of the persisted active harness in `webhook_meta`. */
const ACTIVE_HARNESS_KEY = "failover:active_harness";

/** One row from the worker's shared run-record table. */
export interface WorkerRunRecord {
  id: number;
  origin: string;
  automation_id: string | null;
  task_key: string | null;
  status: string;
  branch: string | null;
  repo: string | null;
  pr_url: string | null;
  outcome_reason: string | null;
  attempt: number | null;
  started_at: number;
  finished_at: number | null;
}

/** One `[[automations]]` entry written into the generated workspace.toml. */
export interface WorkerAutomation {
  id: string;
  /** Defaults to enabled. */
  enabled?: boolean;
  /** Exactly one of cron/interval; defaults to every minute. */
  cron?: string;
  interval?: string;
  prompt: string;
  repo?: string;
  /** Opt-in PR creation; omitted leaves it unset so the default applies. */
  openPr?: boolean;
  /** Treat an occurrence with no repository changes as a successful no-op. */
  allowNoChanges?: boolean;
}

/** One durable schedule cursor from the workspace queue. */
export interface WorkerAutomationSchedule {
  automation_id: string;
  schedule_spec: string;
  next_due_at: number;
  last_scheduled_at: number | null;
}

export interface WorkerFixtureOptions {
  /** Global agent concurrency; defaults to one. */
  maxConcurrency?: number;
  /** Per-repository agent concurrency; defaults to one. */
  maxConcurrencyPerRepo?: number;
  /** Scheduled `[[automations]]` entries; the default workspace has none. */
  automations?: WorkerAutomation[];
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
   * By default the workspace has no task query, automation, estimation, or
   * error monitor, so enqueue work before {@link start}: the worker then takes
   * the documented injection-only exception instead of exiting for lack of
   * configured work. Passing `automations` adds scheduled `[[automations]]`
   * tables to the same generated config.
   */
  async prepare(): Promise<void> {
    const agent = join(this.root, "agent.ts");
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
    chmodSync(agent, 0o700);
    this.env.AGENT_CLI_PATH = agent;
    this.env.E2E_AGENT_INVOCATIONS = join(this.root, "agent-invocations.jsonl");

    mkdirSync(this.workspaceDir, { recursive: true });
    const lines = [
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
    ];
    for (const automation of this.options.automations ?? []) {
      lines.push(...automationTable(automation), "");
    }
    writeFileSync(join(this.workspaceDir, "workspace.toml"), lines.join("\n"));

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

  /**
   * Append one `[[automations]]` table to the live workspace config.
   *
   * The running daemon's `fs.watch` reloader reconciles it without a restart,
   * which is how the test covers live config reload.
   */
  appendAutomation(automation: WorkerAutomation): void {
    const path = join(this.workspaceDir, "workspace.toml");
    const current = readFileSync(path, "utf8").trimEnd();
    writeFileSync(path, `${current}\n\n${automationTable(automation).join("\n")}\n`);
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
    const columns =
      "id, origin, automation_id, task_key, status, branch, repo, pr_url, outcome_reason, attempt, started_at, finished_at";
    return taskKey === undefined
      ? this.query<WorkerRunRecord>(`SELECT ${columns} FROM runs ORDER BY id`)
      : this.query<WorkerRunRecord>(`SELECT ${columns} FROM runs WHERE task_key = ? ORDER BY id`, [
          taskKey,
        ]);
  }

  /** Run records attributed to one scheduled automation, oldest first. */
  automationRuns(automationId: string): WorkerRunRecord[] {
    return this.query<WorkerRunRecord>(
      `SELECT id, origin, automation_id, task_key, status, branch, repo, pr_url, outcome_reason,
              attempt, started_at, finished_at
         FROM runs WHERE automation_id = ? ORDER BY id`,
      [automationId],
    );
  }

  /** Wait for the first terminal run of one scheduled automation. */
  async waitForAutomationRun(automationId: string, timeoutMs = 90_000): Promise<WorkerRunRecord> {
    return await this.waitFor(
      `automation "${automationId}" run to settle`,
      () => this.automationRuns(automationId).find((run) => run.status !== "in_progress"),
      timeoutMs,
    );
  }

  /** Durable schedule cursors, including automations that have not run yet. */
  automationSchedules(): WorkerAutomationSchedule[] {
    return this.query<WorkerAutomationSchedule>(
      `SELECT automation_id, schedule_spec, next_due_at, last_scheduled_at
         FROM automation_schedules ORDER BY automation_id`,
    );
  }

  /** Occurrence task-file names materialized for one automation, oldest first. */
  automationOccurrences(automationId: string): string[] {
    const dir = join(this.workspaceDir, "automations", automationId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  }

  /** Contents of a file on a branch in the local bare repository. */
  branchFile(branch: string, path: string): Promise<string> {
    return checkedCommand(
      ["git", "--git-dir", this.remote, "show", `refs/heads/${branch}:${path}`],
      this.root,
      this.env,
    );
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

export { cliPath };
