import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { checkedCommand } from "../../helpers/process";
import { cliPath } from "../../helpers/scenario";

test.skipIf(!existsSync(cliPath))(
  "built CLI implements, commits and pushes the fixture task using local Git",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-cli-"));
    const cwd = join(root, "repo");
    try {
      cpSync(resolve(import.meta.dir, "../../fixtures/simple-project"), cwd, { recursive: true });
      const env = isolatedEnvironment(root);
      const git = (...args: string[]) => checkedCommand(["git", ...args], cwd, env);
      const remote = join(root, "remote.git");
      await git("init", "--bare", "--initial-branch", "e2e-base", remote);
      await git("init", "--initial-branch", "e2e-base");
      await git("remote", "add", "origin", remote);
      await git("add", ".");
      await git("commit", "-m", "Seed fixture");
      await git("push", "--set-upstream", "origin", "e2e-base");
      const task = join(root, "local-e2e.md");
      writeFileSync(task, "# Expand the greeting\n\nChange the greeting to Hello, world!.\n");
      const agent = join(root, "agent.ts");
      cpSync(resolve(import.meta.dir, "../../helpers/fake-agent.ts"), agent);
      chmodSync(agent, 0o700);
      const output = await checkedCommand(
        [
          process.execPath,
          cliPath,
          task,
          "--agent-path",
          agent,
          "--skip-clarity-check",
          "--skip-comments",
          "--create-pr",
          "--pr-target-branch",
          "e2e-base",
          "--no-update",
        ],
        cwd,
        env,
      );
      expect(output).toContain("Hello, world!");
      expect(await git("branch", "--show-current")).toBe("feature/local-e2e");
      expect(await git("diff", "--name-only", "e2e-base...HEAD")).toBe("src/greeting.ts");
      expect(await git("show", "HEAD:src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(await git("rev-list", "--count", "e2e-base..HEAD")).toBe("1");
      expect(await git("status", "--porcelain")).toBe("");
      const remoteHead = await git("ls-remote", "origin", "refs/heads/feature/local-e2e");
      expect(remoteHead.split(/\s+/)[0]).toBe(await git("rev-parse", "HEAD"));
      expect(output).toContain("Could not detect repository platform");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
