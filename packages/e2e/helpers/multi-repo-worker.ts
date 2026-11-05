/**
 * Multi-repository workspace worker fixture.
 *
 * Runs the real built CLI as a long-lived `devintern worker` against a
 * throwaway workspace with several local bare repositories, a Markdown task
 * directory, and the deterministic agent. Unlike {@link WorkerFixture} it does
 * not enqueue injected tasks: the test seeds Markdown tasks and real
 * `[[teams]]`/`[[routing.rules]]`, so the daemon exercises tracker polling,
 * team-scoped routing, routing skips, and layered task environments.
 *
 * The fixture owns the temporary root, both bare remotes, and the daemon
 * process group. Test code writes `workspace.toml`, `.env`, env files, and task
 * files through {@link writeWorkspaceFile} and {@link writeTask}.
 */

import { Database } from "bun:sqlite";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isolatedEnvironment } from "./environment";
import { cliPath } from "./fixture-workspace";
import { checkedCommand } from "./process";

const packageRoot = resolve(import.meta.dir, "..");
const fixture = join(packageRoot, "fixtures/simple-project");

/** One repository the fixture seeds as a local bare remote. */
export interface MultiRepoSpec {
  name: string;
  remote: string;
  seed: string;
}

/** One row from the worker's shared run-record table. */
export interface MultiRepoRunRecord {
  id: number;
  task_key: string | null;
  team: string | null;
  repo: string | null;
  status: string;
  branch: string | null;
  pr_url: string | null;
  outcome_reason: string | null;
}

/** One row from the worker's routing-skip table, candidates parsed. */
export interface MultiRepoRoutingSkip {
  id: number;
  task_key: string;
  reason: string;
  candidates: string[];
  team: string | null;
  created_at: number;
}

interface OutputWaiter {
  pattern: RegExp;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real multi-repo workspace daemon backed by local bare repositories.
 *
 * Call {@link prepare}, write the workspace files and Markdown tasks, then
 * {@link start} and {@link waitForReady}. Always call {@link dispose} in
 * `finally` so the daemon, any task children, and the temporary root are
 * released.
 */
export class MultiRepoWorkerFixture {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-multi-repo-"));
  readonly workspaceDir = join(this.root, "workspace");
  readonly tasksDir = join(this.root, "tasks");
  readonly baseBranch = "e2e-base";
  readonly env = isolatedEnvironment(this.root);
  readonly globalInvocations = join(this.root, "global-agent-invocations.jsonl");
  readonly repos: MultiRepoSpec[];

  private child: ReturnType<typeof Bun.spawn> | null = null;
  private exitCode: number | undefined;
  private exitPromise: Promise<number> | null = null;
  private output = "";
  private readonly waiters = new Set<OutputWaiter>();

  constructor(repoNames: readonly string[] = ["repo-a", "repo-b"]) {
    this.repos = repoNames.map((name) => ({
      name,
      remote: join(this.root, `${name}.git`),
      seed: join(this.root, `seed-${name}`),
    }));
    this.env.DEVINTERN_WORKSPACE_DIR = this.workspaceDir;
    this.env.WEBHOOK_QUEUE_DB = this.dbPath;
    Object.assign(this.env, {
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

  /** Current captured log length, for "a later line" waits. */
  get outputLength(): number {
    return this.output.length;
  }

  /** Last captured log lines, for failure diagnostics. */
  tail(): string {
    const lines = this.output.trim().split("\n");
    return lines.slice(-80).join("\n");
  }

  /** Whether the daemon process is still running. */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.exitCode === undefined;
  }

  /** Look up one seeded repository by name. */
  repo(name: string): MultiRepoSpec {
    const repo = this.repos.find((candidate) => candidate.name === name);
    if (!repo) throw new Error(`Unknown fixture repo "${name}"`);
    return repo;
  }

  /**
   * Seed every local bare repository and install the deterministic agent.
   *
   * Workspace configuration and tasks are written by the test afterwards so
   * each scenario controls the teams, routing rules, and env layering.
   */
  async prepare(): Promise<void> {
    const agent = join(this.root, "agent.ts");
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
    chmodSync(agent, 0o700);
    this.env.AGENT_CLI_PATH = agent;
    this.env.E2E_AGENT_INVOCATIONS = this.globalInvocations;

    mkdirSync(this.workspaceDir, { recursive: true });
    mkdirSync(this.tasksDir, { recursive: true });

    for (const repo of this.repos) {
      await checkedCommand(
        ["git", "init", "--bare", "--initial-branch", this.baseBranch, repo.remote],
        this.root,
        this.env,
      );
      cpSync(fixture, repo.seed, { recursive: true });
      const git = (...args: string[]) => checkedCommand(["git", ...args], repo.seed, this.env);
      await git("init", "--initial-branch", this.baseBranch);
      await git("remote", "add", "origin", repo.remote);
      await git("add", ".");
      await git("commit", "-m", `Seed ${repo.name} fixture`);
      await git("push", "--set-upstream", "origin", this.baseBranch);
    }
  }

  /** Write a file below the workspace, creating parent directories. */
  writeWorkspaceFile(relativePath: string, content: string): string {
    const path = join(this.workspaceDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  /** Write one Markdown task file into the fixture's task directory. */
  writeTask(fileName: string, content: string): string {
    mkdirSync(this.tasksDir, { recursive: true });
    const path = join(this.tasksDir, fileName);
    writeFileSync(path, content);
    return path;
  }

  /** Touch a file to a strictly newer mtime, forcing one detector cycle. */
  touch(path: string): void {
    const at = new Date(Date.now() + 1_000);
    utimesSync(path, at, at);
  }

  /** Start the real worker daemon in its own process group. */
  start(): void {
    if (this.child) throw new Error("Multi-repo worker fixture is already started");
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

  /** Wait for the workspace worker's live-reload readiness line. */
  async waitForReady(timeoutMs = 30_000): Promise<void> {
    await this.waitForOutput(/Live config reload armed/, timeoutMs, "worker readiness");
  }

  /** Every run record, oldest first. */
  runRecords(): MultiRepoRunRecord[] {
    return this.query<MultiRepoRunRecord>(
      `SELECT id, task_key, team, repo, status, branch, pr_url, outcome_reason
       FROM runs ORDER BY id`,
    );
  }

  /** Every routing-skip row, newest first, with parsed candidates. */
  routingSkips(): MultiRepoRoutingSkip[] {
    const rows = this.query<{
      id: number;
      task_key: string;
      reason: string;
      candidates: string;
      team: string | null;
      created_at: number;
    }>(
      `SELECT id, task_key, reason, candidates, team, created_at
       FROM routing_skips ORDER BY id DESC`,
    );
    return rows.map((row) => ({
      id: row.id,
      task_key: row.task_key,
      reason: row.reason,
      candidates: JSON.parse(row.candidates) as string[],
      team: row.team || null,
      created_at: row.created_at,
    }));
  }

  /** Branch names in one local bare remote. */
  async repoBranches(repoName: string): Promise<string[]> {
    const repo = this.repo(repoName);
    const output = await checkedCommand(
      ["git", "--git-dir", repo.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
      this.root,
      this.env,
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Contents of a file on a branch in one local bare repository. */
  branchFile(repoName: string, branch: string, path: string): Promise<string> {
    const repo = this.repo(repoName);
    return checkedCommand(
      ["git", "--git-dir", repo.remote, "show", `refs/heads/${branch}:${path}`],
      this.root,
      this.env,
    );
  }

  /** Files changed by a branch relative to the seeded base branch. */
  async branchChangedFiles(repoName: string, branch: string): Promise<string[]> {
    const repo = this.repo(repoName);
    const output = await checkedCommand(
      ["git", "--git-dir", repo.remote, "diff", "--name-only", this.baseBranch, branch],
      this.root,
      this.env,
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Modes recorded by the deterministic agent in one invocation JSONL file. */
  agentInvocations(path: string): Array<{ mode: string }> {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { mode: string });
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

  /** Wait for a pattern only in log output captured after `since`. */
  async waitForOutputSince(
    pattern: RegExp,
    since: number,
    timeoutMs = 20_000,
    label = "log line",
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.assertRunning(label);
      if (pattern.test(this.output.slice(since))) return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\n${this.tail()}`);
      }
      await Bun.sleep(100);
    }
  }

  /** SIGTERM the daemon, wait for a graceful exit, then force-kill its group. */
  async stop(timeoutMs = 25_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    // A task subprocess is spawned detached (its own group), so collect the
    // whole descendant tree before the worker exits and reparents any survivor.
    const descendants = this.descendantPids();
    let failure: unknown;
    try {
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
    } catch (error) {
      failure = error;
    }
    const survivors = await this.stopDescendants(descendants);
    this.child = null;
    if (survivors.length > 0) {
      throw new Error(`Could not stop worker child process(es): ${survivors.join(", ")}`);
    }
    if (failure) throw failure;
  }

  /** Stop the daemon, remove every temporary path, and report cleanup failures. */
  async dispose(): Promise<void> {
    let failure: unknown;
    try {
      await this.stop();
    } catch (error) {
      failure = error;
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
    if (failure) throw failure;
  }

  private assertRunning(label: string): void {
    const exitCode = this.exitCode ?? this.child?.exitCode ?? undefined;
    if (exitCode === undefined) return;
    throw new Error(
      `Worker exited with code ${exitCode} while waiting for ${label}\n${this.tail()}`,
    );
  }

  /** Run a read-only queue query, tolerating a database that is still absent. */
  private query<T>(sql: string, params: Array<string | number> = []): T[] {
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

  /** Direct and transitive child pids of the daemon, deepest last. */
  private descendantPids(): number[] {
    const rootPid = this.child?.pid;
    if (!rootPid) return [];
    let table: string;
    try {
      const result = Bun.spawnSync(["ps", "-eo", "pid=,ppid="], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) return [];
      table = result.stdout.toString();
    } catch {
      return [];
    }
    const childrenByParent = new Map<number, number[]>();
    for (const line of table.split("\n")) {
      const [pidText, parentText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      const siblings = childrenByParent.get(parent) ?? [];
      siblings.push(pid);
      childrenByParent.set(parent, siblings);
    }
    const descendants: number[] = [];
    const stack = [...(childrenByParent.get(rootPid) ?? [])];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      descendants.push(pid);
      stack.push(...(childrenByParent.get(pid) ?? []));
    }
    return descendants;
  }

  /** Terminate collected descendant groups, returning any pid still alive. */
  private async stopDescendants(pids: number[]): Promise<number[]> {
    const survivors = pids.filter(isAlive);
    if (survivors.length === 0) return [];
    for (const pid of survivors) {
      this.signalPid(pid, "SIGTERM");
    }
    await this.waitForPidsToExit(survivors, 5_000);
    for (const pid of survivors.filter(isAlive)) {
      this.signalPid(pid, "SIGKILL");
    }
    await this.waitForPidsToExit(survivors, 2_000);
    return survivors.filter(isAlive);
  }

  private signalPid(pid: number, signal: NodeJS.Signals): void {
    try {
      // A detached task child is its own group leader.
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }

  private async waitForPidsToExit(pids: number[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && pids.some(isAlive)) {
      await Bun.sleep(50);
    }
  }
}

export { cliPath };
