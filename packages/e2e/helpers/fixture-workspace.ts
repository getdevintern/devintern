import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "./environment";
import { checkedCommand, command } from "./process";

const packageRoot = resolve(import.meta.dir, "..");
export const cliPath = resolve(packageRoot, "../code/dist/index.js");

export class FixtureWorkspace {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-"));
  readonly cwd = join(this.root, "repo");
  readonly id = `e2e-${crypto.randomUUID()}`;
  readonly base = `e2e/base-${this.id}`;
  readonly head = `feature/${this.id}`;
  readonly env = isolatedEnvironment(this.root);
  readonly ownedBranches = new Set([this.head, this.base]);

  constructor(private readonly apiTokenVariable = "GITHUB_TOKEN") {}

  async prepare(
    remoteUrl: string,
    token: string,
    providerEnv: Record<string, string>,
    gitUsername = "x-access-token",
  ): Promise<void> {
    cpSync(join(packageRoot, "fixtures/simple-project"), this.cwd, { recursive: true });
    mkdirSync(join(this.root, "bin"));
    const agent = join(this.root, "bin/agent.ts");
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
    chmodSync(agent, 0o700);
    this.env.E2E_AGENT_INVOCATIONS = join(this.root, "agent-invocations.jsonl");
    this.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(this.root, "review-worktree");

    // Token stays in the subprocess environment, never in a URL, argv or git config.
    const askpass = join(this.root, "bin/askpass.sh");
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$E2E_GIT_USERNAME" ;;\n  *Password*) printf "%s\\n" "$E2E_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o700 },
    );
    Object.assign(this.env, {
      E2E_GIT_TOKEN: token,
      E2E_GIT_USERNAME: gitUsername,
      ...providerEnv,
      GIT_ASKPASS: askpass,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "commit.gpgsign",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
    });
    await this.git("init", "--initial-branch", this.base);
    await this.git("remote", "add", "origin", remoteUrl);
    await this.git("add", ".");
    await this.git("commit", "-m", "Seed isolated E2E fixture");
    await this.git("push", "--set-upstream", "origin", this.base);
    // Fetch establishes remote branch refs without cloning unrelated project files.
    await this.git("fetch", "origin", this.base);
    writeFileSync(
      join(this.root, `${this.id}.md`),
      `---\nkey: ${this.id}\n---\n# Expand the greeting\n\nChange the greeting to Hello, world! and run bun test.\n`,
    );
  }

  git(...args: string[]): Promise<string> {
    return checkedCommand(["git", ...args], this.cwd, this.env);
  }

  async runTask(
    options: {
      apiToken?: string;
      implicitTarget?: boolean;
      agentMode?: "implement" | "fail" | "no-change";
      gitToken?: string;
    } = {},
  ) {
    return command(
      [
        process.execPath,
        cliPath,
        join(this.root, `${this.id}.md`),
        "--agent-path",
        join(this.root, "bin/agent.ts"),
        "--skip-clarity-check",
        "--skip-comments",
        "--create-pr",
        ...(options.implicitTarget ? [] : ["--pr-target-branch", this.base]),
        "--hook-retries",
        "0",
        "--no-update",
      ],
      this.cwd,
      {
        ...this.env,
        E2E_AGENT_MODE: options.agentMode ?? "implement",
        ...(options.gitToken === undefined ? {} : { E2E_GIT_TOKEN: options.gitToken }),
        ...(options.apiToken === undefined ? {} : { [this.apiTokenVariable]: options.apiToken }),
      },
    );
  }

  async runCli(apiToken?: string, implicitTarget = false) {
    const result = await this.runTask({ apiToken, implicitTarget });
    if (result.exitCode !== 0)
      throw new Error(`CLI exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
    return result;
  }

  async runReview(url: string) {
    return command([process.execPath, cliPath, "address-review", url], this.cwd, {
      ...this.env,
      AGENT_CLI_PATH: join(this.root, "bin/agent.ts"),
      E2E_AGENT_MODE: "review",
    });
  }

  async remoteSha(branch: string): Promise<string | undefined> {
    const value = await this.git("ls-remote", "origin", `refs/heads/${branch}`);
    return value ? value.split(/\s+/)[0] : undefined;
  }

  async seedBranchCollision(): Promise<{ existingSha: string; attemptHead: string }> {
    await this.git("checkout", "-b", this.head);
    writeFileSync(join(this.cwd, "existing-work.txt"), "Preserve this existing implementation.\n");
    await this.git("add", "existing-work.txt");
    await this.git("commit", "-m", "Seed existing work that must be preserved");
    const existingSha = await this.git("rev-parse", "HEAD");
    await this.git("push", "origin", this.head);
    await this.git("checkout", this.base);
    // Leave only the remote ref, matching a fresh clone of a previous attempt.
    await this.git("branch", "-D", this.head);
    const attemptHead = `${this.head}-attempt-2`;
    this.ownedBranches.add(attemptHead);
    return { existingSha, attemptHead };
  }

  runRecords(): Array<{ status: string; pr_url: string | null; outcome_reason: string | null }> {
    const db = new Database(this.env.WEBHOOK_QUEUE_DB, { readonly: true });
    try {
      return db
        .query("SELECT status, pr_url, outcome_reason FROM runs WHERE task_key = ? ORDER BY id")
        .all(this.id) as Array<{
        status: string;
        pr_url: string | null;
        outcome_reason: string | null;
      }>;
    } finally {
      db.close();
    }
  }

  agentInvocations(): Array<{ mode: string }> {
    const path = this.env.E2E_AGENT_INVOCATIONS;
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    if (!this.ownedBranches.has(branch))
      throw new Error("Refusing to delete a branch not owned by this scenario");
    const check = () =>
      command(
        ["git", "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
        this.cwd,
        this.env,
      );
    const before = await check();
    if (before.exitCode === 2) return;
    if (before.exitCode !== 0)
      throw new Error(`Could not check remote branch ${branch}: ${before.stderr}`);
    await this.git("push", "origin", "--delete", branch);
    const after = await check();
    if (after.exitCode !== 2)
      throw new Error(`Remote branch cleanup failed for ${branch}: ${after.stderr}`);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
