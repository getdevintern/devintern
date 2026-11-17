import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath, FixtureWorkspace } from "../../helpers/fixture-workspace";
import { checkedCommand } from "../../helpers/process";

/**
 * Seed a local bare Git remote so the run exercises the production git path
 * without a hosted code host. `--create-pr` still pushes and exits 0 because
 * no supported platform is detected.
 *
 * @param run - Fixture workspace whose isolated environment is reused
 */
async function prepareLocalRemote(run: FixtureWorkspace): Promise<void> {
  const remote = join(run.root, "remote.git");
  await checkedCommand(["git", "init", "--bare", remote], run.root, run.env);
  await run.prepare(remote, "test-token", {});
}

/**
 * Path of the auto-review summary the CLI writes under the output directory.
 *
 * @param run - Fixture workspace that ran the task
 */
function autoReviewDir(run: FixtureWorkspace): string {
  return join(run.env.DEVINTERN_OUTPUT_DIR, run.taskKey.toLowerCase());
}

/**
 * Read and parse a JSON artifact, failing with its path when it is absent.
 *
 * @param path - Artifact path inside the fixture's temporary output directory
 */
function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`Expected artifact was not written: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The exact base-to-head diff the two auto-review commits must produce. */
const EXPECTED_GREETING_DIFF = [
  "diff --git a/src/greeting.ts b/src/greeting.ts",
  "--- a/src/greeting.ts",
  "+++ b/src/greeting.ts",
  "@@ -1 +1 @@",
  '-export const greeting = "Hello";',
  '+export const greeting = "Hello, reviewer!";',
].join("\n");

test.skipIf(!existsSync(cliPath))(
  "the local --auto-review loop fixes a finding, approves, and pushes both commits",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      const result = await run.runTask({
        extraArgs: ["--auto-review", "--auto-review-iterations", "2"],
      });

      expect(result.exitCode).toBe(0);
      // The local bare remote has no supported PR host: the documented behavior
      // is still to push the branch and exit successfully, without a PR URL.
      expect(await run.remoteSha(run.head)).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.git("branch", "--show-current")).toBe(run.head);

      // The loop's fix commit lands on the same task branch: implementation
      // plus exactly one review-fix commit.
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("2");
      expect(await run.git("log", "-1", "--format=%s")).toBe("fix: address PR review feedback");
      expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
      expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
        'export const greeting = "Hello, reviewer!";',
      );
      const diff = await run.git("diff", `${run.base}...HEAD`, "--", "src/greeting.ts");
      expect(
        diff
          .split("\n")
          .filter((line) => !line.startsWith("index "))
          .join("\n"),
      ).toBe(EXPECTED_GREETING_DIFF);

      const outputDir = autoReviewDir(run);
      const summary = readJson(join(outputDir, "auto-review-summary.json"));
      expect(summary.iterations).toBe(2);
      expect(summary.success).toBe(true);
      expect(summary.history).toHaveLength(2);

      const firstFeedback = readJson(join(outputDir, "iteration-1", "feedback.json")) as {
        items: Array<Record<string, unknown>>;
      };
      expect(firstFeedback.items).toHaveLength(1);
      expect(firstFeedback.items[0]).toMatchObject({
        priority: "medium",
        category: "code-quality",
      });
      expect(firstFeedback.items[0].issue).toBeTruthy();
      expect(firstFeedback.items[0].suggestion).toBeTruthy();
      expect(firstFeedback.items[0].evidence).toBeTruthy();

      // One implementation turn, then review → fix → review: the second review
      // approves and ends the loop before the cap.
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "implement",
        "auto-review-feedback",
        "auto-review-fix",
        "auto-review-feedback",
      ]);

      expect(result.stdout).toContain("Auto-review loop finished after 2 iteration(s)");
      // The loop stops on "no important issues to address" before its
      // `approved` check, so the converged success is this line plus the
      // success status, not the unreachable `PR approved` branch.
      expect(result.stdout).toContain("No important issues to address. Review loop complete!");
      expect(result.stdout).toContain("Status: ✅ Success");
      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
      expect(await run.git("status", "--porcelain")).toBe("");
    } finally {
      run.dispose();
    }
  },
  60_000,
);

test.skipIf(!existsSync(cliPath))(
  "the --auto-review-iterations cap stops a non-converging review after one cycle",
  async () => {
    const run = new FixtureWorkspace();
    try {
      await prepareLocalRemote(run);
      run.env.E2E_AUTO_REVIEW_STUCK = "1";
      const result = await run.runTask({
        extraArgs: ["--auto-review", "--auto-review-iterations", "1"],
      });

      // A non-approved review is reported, not fatal: the branch is still
      // delivered with the fix commit.
      expect(result.exitCode).toBe(0);
      expect(run.agentInvocations().map((invocation) => invocation.mode)).toEqual([
        "implement",
        "auto-review-feedback",
        "auto-review-fix",
      ]);
      expect(await run.remoteSha(run.head)).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("2");
      expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
        'export const greeting = "Hello, reviewer!";',
      );

      const summary = readJson(join(autoReviewDir(run), "auto-review-summary.json"));
      expect(summary.iterations).toBe(1);
      expect(summary.success).toBe(false);
      expect(summary.history).toHaveLength(1);

      expect(result.stdout).toContain("Auto-review loop finished after 1 iteration(s)");
      expect(result.stdout).toContain("Incomplete");
      expect(run.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
      expect(await run.git("status", "--porcelain")).toBe("");
    } finally {
      run.dispose();
    }
  },
  60_000,
);
