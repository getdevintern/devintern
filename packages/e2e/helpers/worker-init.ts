/**
 * Fixture for `devintern worker init` e2e tests (non-interactive and PTY
 * wizard).
 *
 * Every test owns one temporary root holding HOME, the workspace, a local
 * bare Git remote plus a checkout whose `origin` points at it, and a Markdown
 * task folder, so no tracker account, code host, or network is involved.
 *
 * PATH is built from scratch instead of inheriting the contributor's: a
 * `tools/` directory with only `git`, `which`, and `bun`, plus (optionally) a stub
 * `claude` agent CLI. A real agent CLI installed on the host can therefore
 * neither satisfy nor break the harness check.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isolatedEnvironment } from "./environment";
import { cliPath } from "./fixture-workspace";
import { checkedCommand, command } from "./process";
import type { CommandResult } from "./process";

/** The `--json` document `worker init --non-interactive` prints. */
export interface WorkerInitReport {
  schema: string;
  version: number;
  result: "success" | "failure";
  error?: string;
  workspaceDir: string;
  tracker: string | null;
  taskQuery: string | null;
  repo: { name: string; remote: string; added: boolean } | null;
  filesWritten: string[];
  checks: Array<{
    name: string;
    label: string;
    status: "pass" | "warn" | "fail" | "skipped";
    message: string;
    hint?: string;
  }>;
  nextSteps: Array<{ id: string; message: string; command: string }>;
}

/** The parts of `workspace.toml` the init tests assert on. */
export interface InitWorkspaceToml {
  defaults?: { tracker?: string; task_query?: string };
  repos?: Array<{ name: string; remote: string }>;
}

export interface WorkerInitFixtureOptions {
  /** Put a stub `claude` CLI on PATH (default true). */
  agent?: boolean;
  /** Number of `status: todo` Markdown tasks to seed (default 1). */
  tasks?: number;
}

/** Stack-trace and abort-noise markers that must never reach the user. */
export const STACK_TRACE_PATTERNS: readonly RegExp[] = [
  /AbortError/,
  /^\s+at\s.+[(:]\d+/m,
  /\bError: /,
  /node:internal/,
];

function requireExecutable(name: string): string {
  const found = Bun.which(name);
  if (!found) throw new Error(`worker-init fixture: ${name} is not on PATH`);
  return found;
}

export class WorkerInitFixture {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-worker-init-"));
  readonly env: Record<string, string>;
  readonly workspaceDir: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly tasksDir: string;
  readonly remoteDir: string;
  readonly repoDir: string;

  constructor(options: WorkerInitFixtureOptions = {}) {
    const tools = join(this.root, "tools");
    mkdirSync(tools, { recursive: true });
    // `which` is how the harness check looks up the agent CLI.
    for (const name of ["git", "which"]) symlinkSync(requireExecutable(name), join(tools, name));
    symlinkSync(process.execPath, join(tools, "bun"));
    const path = [tools];
    if (options.agent ?? true) {
      const agentDir = join(this.root, "agent-bin");
      mkdirSync(agentDir, { recursive: true });
      const stub = join(agentDir, "claude");
      writeFileSync(stub, "#!/bin/sh\necho 'stub agent 0.0.0'\n");
      chmodSync(stub, 0o755);
      path.unshift(agentDir);
    }

    const base = isolatedEnvironment(this.root);
    // Init writes TASK_TRACKER itself; leave it unset so the flags decide.
    delete base.TASK_TRACKER;
    this.env = { ...base, PATH: path.join(delimiter) };
    this.workspaceDir = this.env.DEVINTERN_WORKSPACE_DIR!;
    this.configPath = join(this.workspaceDir, "workspace.toml");
    this.envPath = join(this.workspaceDir, ".env");

    this.tasksDir = join(this.root, "tasks");
    mkdirSync(this.tasksDir, { recursive: true });
    for (let i = 1; i <= (options.tasks ?? 1); i++) {
      writeFileSync(
        join(this.tasksDir, `T-${i}.md`),
        `---\nstatus: todo\n---\n# Sample task ${i}\n\nDo a thing.\n`,
      );
    }
    this.remoteDir = join(this.root, "remotes", "acme-app.git");
    this.repoDir = join(this.root, "checkouts", "acme-app");
  }

  /** Bare remote plus a checkout whose origin points at it. */
  async seedRepository(): Promise<void> {
    mkdirSync(join(this.root, "remotes"), { recursive: true });
    await checkedCommand(
      ["git", "init", "--bare", "--initial-branch", "main", this.remoteDir],
      this.root,
      this.env,
    );
    mkdirSync(this.repoDir, { recursive: true });
    await checkedCommand(["git", "init", "--initial-branch", "main"], this.repoDir, this.env);
    writeFileSync(join(this.repoDir, "README.md"), "# Fixture\n");
    await checkedCommand(["git", "add", "."], this.repoDir, this.env);
    await checkedCommand(["git", "commit", "-m", "Initial commit"], this.repoDir, this.env);
    await checkedCommand(
      ["git", "remote", "add", "origin", this.remoteDir],
      this.repoDir,
      this.env,
    );
    await checkedCommand(
      ["git", "push", "--set-upstream", "origin", "main"],
      this.repoDir,
      this.env,
    );
  }

  /** Run the built CLI with stdin closed and stdout/stderr piped (no TTY). */
  run(
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<CommandResult> {
    return command(
      [process.execPath, cliPath, ...args],
      options.cwd ?? this.repoDir,
      { ...this.env, ...options.env },
      180_000,
    );
  }

  /** `worker init --non-interactive` for the seeded Markdown tracker. */
  init(
    extra: string[] = [],
    options: { cwd?: string; env?: Record<string, string>; query?: string } = {},
  ): Promise<CommandResult> {
    return this.run(
      [
        "worker",
        "init",
        "--non-interactive",
        "--tracker",
        "markdown",
        "--task-query",
        options.query ?? "status=todo",
        "--repo-from-cwd",
        ...extra,
      ],
      { cwd: options.cwd, env: { MARKDOWN_TASKS_DIR: this.tasksDir, ...options.env } },
    );
  }

  /** Files directly inside the workspace directory (empty when it does not exist). */
  workspaceFiles(): string[] {
    if (!existsSync(this.workspaceDir)) return [];
    return readdirSync(this.workspaceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }

  /** sha256 of a workspace file, or "absent". */
  hash(path: string): string {
    return existsSync(path)
      ? createHash("sha256").update(readFileSync(path)).digest("hex")
      : "absent";
  }

  config(): InitWorkspaceToml {
    return Bun.TOML.parse(readFileSync(this.configPath, "utf8")) as InitWorkspaceToml;
  }

  release(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Parse stdout as exactly one JSON document (throws on trailing text). */
export function parseReport(stdout: string): WorkerInitReport {
  return JSON.parse(stdout) as WorkerInitReport;
}

/** Non-empty output lines. */
export function outputLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

export function stripAnsi(value: string): string {
  // oxlint-disable-next-line no-control-regex -- terminal escape sequences are the input here
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "").replace(/\r/g, "");
}
