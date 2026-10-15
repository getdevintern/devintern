import { chmodSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  constructor(private readonly apiTokenVariable = "GITHUB_TOKEN") {}

  async prepare(
    remoteUrl: string,
    token: string,
    providerEnv: Record<string, string>,
  ): Promise<void> {
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

  async runCli(apiToken?: string, implicitTarget = false) {
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
        ...(implicitTarget ? [] : ["--pr-target-branch", this.base]),
        "--hook-retries",
        "0",
        "--no-update",
      ],
      this.cwd,
      { ...this.env, ...(apiToken === undefined ? {} : { [this.apiTokenVariable]: apiToken }) },
    );
    if (result.exitCode !== 0) {
      throw new Error(`CLI exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`);
    }
    return result;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
