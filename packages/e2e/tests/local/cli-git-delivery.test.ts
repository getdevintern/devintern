import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { checkedCommand } from "../../helpers/process";

/**
 * Seed a local bare Git remote so the run exercises the production git path
 * without a hosted code host.
 *
 * @param run - Fixture workspace whose isolated environment is reused
 */
async function prepareLocalRemote(run: FixtureWorkspace): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {});
}

/**
 * Exact status line for the fake agent's edit. `checkedCommand` trims the
 * output, so the porcelain two-column prefix loses its leading space; the
 * explicit `git diff`/`git diff --cached` assertions below distinguish an
 * unstaged working-tree edit from a staged one.
 */
const EXPECTED_GREETING_STATUS = "M src/greeting.ts";

test.skipIf(!existsSync(cliPath))(
  "--no-git keeps --create-pr from committing, pushing, or opening a PR",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      // `runTask` always passes `--create-pr`. Keeping it here proves the
      // `enableGit` guard (`git && autoCommit`) suppresses delivery even when a
      // PR was requested, which is how automations with `open_pr = false` layer
      // `--no-git` on top of a `--create-pr` workspace default.
      const result = await run.runTask({ extraArgs: ["--no-git"] });

      expect(result.exitCode).toBe(0);

      // No feature branch, commit, or push: the base branch keeps the agent's
      // edit in the working tree.
      expect(await run.git("branch", "--show-current")).toBe(run.base);
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
      expect(await run.git("status", "--porcelain")).toBe(EXPECTED_GREETING_STATUS);
      expect(await run.git("diff", "--name-only")).toBe("src/greeting.ts");
      expect(await run.git("diff", "--cached", "--name-only")).toBe("");
      expect(await run.git("diff", "--name-only", run.base)).toBe("src/greeting.ts");
      expect(await run.git("show", `${run.base}:src/greeting.ts`)).toBe(
        'export const greeting = "Hello";',
      );
      expect(await run.git("ls-remote", "origin", "refs/heads/feature/*")).toBe("");

      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
      // `--create-pr` was requested, but no PR may be recorded.
      expect(run.runRecords().map((record) => record.pr_url)).toEqual([null]);

      // The output must not claim delivery steps that were deliberately skipped.
      expect(result.stdout).not.toContain("Committing changes");
      expect(result.stdout).not.toContain("Successfully committed changes");
      expect(result.stdout).not.toContain("Pushing branch to remote");
      expect(result.stdout).not.toContain("Creating pull request");
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "--no-auto-commit keeps --create-pr from committing, pushing, or opening a PR",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      // As above, `--create-pr` is still passed so the only thing preventing
      // delivery is `enableGit` being false for `--no-auto-commit`.
      const result = await run.runTask({ extraArgs: ["--no-auto-commit"] });

      expect(result.exitCode).toBe(0);

      // The feature branch exists, but it has no commits beyond the base and
      // the agent's edit stays in the working tree and off the remote.
      expect(await run.git("branch", "--show-current")).toBe(run.head);
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
      expect(await run.git("status", "--porcelain")).toBe(EXPECTED_GREETING_STATUS);
      expect(await run.git("diff", "--name-only")).toBe("src/greeting.ts");
      expect(await run.git("diff", "--cached", "--name-only")).toBe("");
      expect(await run.git("diff", "--name-only", run.head)).toBe("src/greeting.ts");
      expect(await run.git("show", `${run.head}:src/greeting.ts`)).toBe(
        'export const greeting = "Hello";',
      );
      expect(await run.git("ls-remote", "origin", "refs/heads/feature/*")).toBe("");

      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
      // `--create-pr` was requested, but no PR may be recorded.
      expect(run.runRecords().map((record) => record.pr_url)).toEqual([null]);

      // The output must not claim delivery steps that were deliberately skipped.
      expect(result.stdout).not.toContain("Committing changes");
      expect(result.stdout).not.toContain("Successfully committed changes");
      expect(result.stdout).not.toContain("Pushing branch to remote");
      expect(result.stdout).not.toContain("Creating pull request");
    } finally {
      run.dispose();
    }
  },
  60_000,
);

/** Drop the identity `isolatedEnvironment` injects, leaving git none at all. */
function removeGitIdentity(run: FixtureWorkspace): void {
  const env: Record<string, string | undefined> = run.env;
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    delete env[key];
  }
}

for (const scenario of [
  {
    name: "with no git identity and no setting, the task commits as the DevIntern fallback",
    env: {} as Record<string, string>,
    identity: "DevIntern <devintern@users.noreply.github.com>",
  },
  {
    name: "with no git identity, the task commits with the git_author workspace setting",
    env: {
      DEVINTERN_GIT_AUTHOR_NAME: "Workspace Bot",
      DEVINTERN_GIT_AUTHOR_EMAIL: "bot@example.invalid",
    } as Record<string, string>,
    identity: "Workspace Bot <bot@example.invalid>",
  },
]) {
  test.skipIf(!existsSync(cliPath))(
    scenario.name,
    async () => {
      const run = new FixtureWorkspace();
      try {
        await prepareLocalRemote(run);
        // Seeding needed an identity; the run itself gets none: no
        // GIT_AUTHOR_*/GIT_COMMITTER_*, and global/system config are off.
        removeGitIdentity(run);
        Object.assign(run.env, scenario.env);
        expect(run.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        const result = await run.runTask();
        const output = `${result.stdout}\n${result.stderr}`;

        expect(output).not.toContain("Author identity unknown");
        expect(output).not.toContain("Git hook failed");
        expect(await run.git("ls-remote", "origin", `refs/heads/${run.head}`), output).not.toBe("");
        await run.git("fetch", "--quiet", "origin", run.head);
        expect(await run.git("log", "-1", "--format=%an <%ae>|%cn <%ce>", "FETCH_HEAD")).toBe(
          `${scenario.identity}|${scenario.identity}`,
        );
        expect(await run.git("diff", "--name-only", `${run.base}...FETCH_HEAD`)).toBe(
          "src/greeting.ts",
        );
        // Nothing was written to git config to get there.
        expect(await run.git("config", "--local", "--list")).not.toContain("user.");
      } finally {
        run.dispose();
      }
    },
    60_000,
  );
}
