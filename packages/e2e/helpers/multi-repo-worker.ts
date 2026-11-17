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
 * The fixture owns the temporary root, its bare remotes, and the daemon
 * process group. Test code writes `workspace.toml`, `.env`, env files, and task
 * files through {@link writeWorkspaceFile} and {@link writeTask}.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cliPath } from "./fixture-workspace";
import { checkedCommand } from "./process";
import { WorkerFixture } from "./worker";

const packageRoot = resolve(import.meta.dir, "..");
const fixture = join(packageRoot, "fixtures/simple-project");

/** One repository the fixture seeds as a local bare remote. */
export interface MultiRepoSpec {
  name: string;
  remote: string;
  seed: string;
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

/**
 * Real multi-repo workspace daemon backed by local bare repositories.
 *
 * Call {@link prepare}, write the workspace files and Markdown tasks, then
 * {@link start} and {@link waitForReady}. Always call {@link dispose} in
 * `finally` so the daemon, any task children, and the temporary root are
 * released.
 */
export class MultiRepoWorkerFixture extends WorkerFixture {
  readonly tasksDir: string;
  readonly globalInvocations: string;
  readonly repos: MultiRepoSpec[];

  constructor(repoNames: readonly string[] = ["repo-a", "repo-b"]) {
    super({ rootPrefix: "devintern-e2e-multi-repo-" });
    this.tasksDir = join(this.root, "tasks");
    this.globalInvocations = join(this.root, "global-agent-invocations.jsonl");
    this.repos = repoNames.map((name) => ({
      name,
      remote: join(this.root, `${name}.git`),
      seed: join(this.root, `seed-${name}`),
    }));
  }

  /** Current captured log length, for "a later line" waits. */
  get outputLength(): number {
    return this.logs.length;
  }

  /**
   * Seed every local bare repository and install the deterministic agent.
   *
   * Workspace configuration and tasks are written by the test afterwards so
   * each scenario controls the teams, routing rules, and env layering.
   */
  override async prepare(): Promise<void> {
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

  /** Wait for the workspace worker's live-reload readiness line. */
  override async waitForReady(timeoutMs = 30_000): Promise<void> {
    await this.waitForOutput(/Live config reload armed/, timeoutMs, "worker readiness");
  }

  /** Look up one seeded repository by name. */
  repo(name: string): MultiRepoSpec {
    const repo = this.repos.find((candidate) => candidate.name === name);
    if (!repo) throw new Error(`Unknown fixture repo "${name}"`);
    return repo;
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
  repoBranchFile(repoName: string, branch: string, path: string): Promise<string> {
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
  override agentInvocations(path: string = this.globalInvocations): Array<{ mode: string }> {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { mode: string });
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
      if (pattern.test(this.logs.slice(since))) return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\n${this.tail()}`);
      }
      await Bun.sleep(100);
    }
  }
}

export { cliPath };
