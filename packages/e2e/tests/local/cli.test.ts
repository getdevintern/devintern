import { expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "../../helpers/environment";
import { FixtureWorkspace } from "../../helpers/fixture-workspace";
import { checkedCommand } from "../../helpers/process";
import { cliPath } from "../../helpers/scenario";

test.skipIf(!existsSync(cliPath))(
  "FixtureWorkspace runs the Markdown fixture and derives the branch from its task key",
  async () => {
    const run = new FixtureWorkspace();
    const remote = join(run.root, "remote.git");
    try {
      await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
      await run.prepare(remote, "test-token", {});
      expect(run.taskKey).toBe(run.id);
      await run.runCli();
      expect(await run.git("branch", "--show-current")).toBe(run.head);
      expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "a leftover remote-only feature branch makes the CLI work on -attempt-2 and preserves it",
  async () => {
    const run = new FixtureWorkspace();
    const remote = join(run.root, "remote.git");
    const seed = join(run.root, "seed");
    try {
      await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
      // Seed a foreign branch under the fixture's derived task key on the shared
      // remote, then prepare a fresh workspace that must discover it.
      mkdirSync(seed, { recursive: true });
      await checkedCommand(["git", "init", "--initial-branch", "seed"], seed, run.env);
      writeFileSync(join(seed, "foreign.txt"), "preserve me\n");
      await checkedCommand(["git", "add", "."], seed, run.env);
      await checkedCommand(["git", "commit", "-m", "foreign attempt"], seed, run.env);
      await checkedCommand(["git", "remote", "add", "origin", remote], seed, run.env);
      await checkedCommand(["git", "push", "origin", "seed"], seed, run.env);
      await checkedCommand(["git", "checkout", "-b", run.head], seed, run.env);
      await checkedCommand(["git", "push", "origin", run.head], seed, run.env);
      const foreignSha = await checkedCommand(["git", "rev-parse", "HEAD"], seed, run.env);

      await run.prepare(remote, "test-token", {});
      await run.runCli();

      // The run must have fallen back to the attempt branch instead of failing
      // on a rejected push, and must never have touched the foreign ref.
      expect(await run.git("branch", "--show-current")).toBe(`${run.head}-attempt-2`);
      expect(await run.remoteSha(run.head)).toBe(foreignSha);
      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
    } finally {
      run.dispose();
    }
  },
  60_000,
);

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
