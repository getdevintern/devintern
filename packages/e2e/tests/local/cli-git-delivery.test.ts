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
  "--no-git leaves the agent's change on the base branch without committing or pushing",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      const result = await run.runTask({ createPr: false, extraArgs: ["--no-git"] });

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
  "--no-auto-commit creates the feature branch but leaves the change uncommitted and unpushed",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      const result = await run.runTask({ createPr: false, extraArgs: ["--no-auto-commit"] });

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
