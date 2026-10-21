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
  status: "pending" | "running" | "done" | "failed";
  message: string | null;
  task_file: string;
}

/** One row from the worker's shared run-record table. */
export interface WorkerRunRecord {
  id: number;
  task_key: string | null;
  status: string;
  branch: string | null;
  repo: string | null;
  pr_url: string | null;
  outcome_reason: string | null;
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
 * Call {@link prepare}, {@link start}, and {@link waitForReady} before adding
 * tasks. Always call {@link dispose} in `finally` so the daemon and temporary
 * directories are released.
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

  /** Whether the daemon process is still running. */
  get running(): boolean {
    return this.child !== null && this.exitCode === undefined;
  }

  /**
   * Seed the local bare repository and write a credential-free workspace.
   *
   * The disabled automation exists only to satisfy the worker's startup guard:
   * an injection-only workspace has no tracker query, so without any other
   * configured work the daemon would exit before it could drain tasks.
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
        "[[automations]]",
        'id = "e2e-keepalive"',
        "enabled = false",
        'prompt = "unused"',
        'interval = "1d"',
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

  /** Enqueue one task through the built CLI and return its durable row. */
  async addTask(input: { title: string; body: string }): Promise<WorkerInjectedTask> {
    const stdout = await checkedCommand(
      [
        process.execPath,
        cliPath,
        "worker",
        "add",
        "--repo",
        this.repoName,
        "--title",
        input.title,
        "--body",
        input.body,
        "--json",
      ],
      this.workspaceDir,
      this.env,
    );
    const result = JSON.parse(stdout) as { id?: unknown };
    if (typeof result.id !== "number") {
      throw new Error(`worker add did not return a task id: ${stdout}`);
    }
    const task = this.injectedTask(result.id);
    if (!task) throw new Error(`Enqueued task #${result.id} was not readable from ${this.dbPath}`);
    return task;
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
      "SELECT id, task_key, repo, status, message, task_file FROM injected_tasks WHERE id = ?",
      id,
    )[0];
  }

  /** Read run records, optionally scoped to one task key. */
  runRecords(taskKey?: string): WorkerRunRecord[] {
    return taskKey === undefined
      ? this.query<WorkerRunRecord>(
          "SELECT id, task_key, status, branch, repo, pr_url, outcome_reason FROM runs ORDER BY id",
        )
      : this.query<WorkerRunRecord>(
          "SELECT id, task_key, status, branch, repo, pr_url, outcome_reason FROM runs WHERE task_key = ? ORDER BY id",
          taskKey,
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
    if (this.exitCode !== undefined) {
      throw new Error(`Worker already exited with code ${this.exitCode}\n${this.tail()}`);
    }
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

  /** Run a read-only queue query, tolerating a database that is still absent. */
  private query<T>(sql: string, ...params: Array<string | number>): T[] {
    if (!existsSync(this.dbPath)) return [];
    let db: Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });
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

  private tail(): string {
    const lines = this.output.trim().split("\n");
    return lines.slice(-80).join("\n");
  }
}

export { cliPath };
