import { chmodSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitHub } from "../providers/github";
import { isolatedEnvironment } from "./environment";
import { checkedCommand, command } from "./process";

const packageRoot = resolve(import.meta.dir, "..");
export const cliPath = resolve(packageRoot, "../code/dist/index.js");

export class Scenario {
  readonly root = mkdtempSync(join(tmpdir(), "devintern-e2e-"));
  readonly cwd = join(this.root, "repo");
  readonly id = `e2e-${crypto.randomUUID()}`;
  readonly base = `e2e/base-${this.id}`;
  readonly head = `feature/${this.id}`;
  readonly env = isolatedEnvironment(this.root);

  constructor(readonly github: GitHub) {}

  async setup(token: string): Promise<void> {
    // Verify credentials and repository access before creating any resources.
    await this.github.request("");
    cpSync(join(packageRoot, "fixtures/simple-project"), this.cwd, { recursive: true });
    mkdirSync(join(this.root, "bin"));
    const agent = join(this.root, "bin/agent.ts");
    cpSync(join(packageRoot, "helpers/fake-agent.ts"), agent);
    chmodSync(agent, 0o700);

    // Token stays in the subprocess environment, never in a URL, argv or git config.
    const askpass = join(this.root, "bin/askpass.sh");
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) printf "%s\\n" "$E2E_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o700 },
    );
    Object.assign(this.env, {
      E2E_GIT_TOKEN: token,
      GITHUB_TOKEN: token,
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
    await this.git("remote", "add", "origin", `https://github.com/${this.github.repository}.git`);
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

  async runCli(apiToken?: string) {
    const result = await command(
      [
        process.execPath,
        cliPath,
        join(this.root, `${this.id}.md`),
        "--agent-path",
        join(this.root, "bin/agent.ts"),
        "--skip-clarity-check",
        "--skip-comments",
        "--create-pr",
        "--pr-target-branch",
        this.base,
        "--hook-retries",
        "0",
        "--no-update",
      ],
      this.cwd,
      { ...this.env, GITHUB_TOKEN: apiToken ?? this.env.GITHUB_TOKEN },
    );
    if (result.exitCode !== 0) {
      throw new Error(`CLI exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
    }
    return result;
  }

  async cleanup(): Promise<void> {
    // Attempt every cleanup even if a preceding operation fails.
    const errors: unknown[] = [];
    try {
      const pulls = await this.github.pulls(this.head);
      for (const pull of pulls.filter((item) => item.state === "open")) {
        try {
          await this.github.request(`/pulls/${pull.number}`, "PATCH", { state: "closed" });
        } catch (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      errors.push(error);
    }
    for (const branch of [this.head, this.base]) {
      try {
        await this.github.deleteBranch(branch);
      } catch (error) {
        errors.push(error);
      }
    }
    rmSync(this.root, { recursive: true, force: true });
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Cleanup failed for ${this.id}; inspect ${this.head} and ${this.base}`,
      );
    }
  }
}
