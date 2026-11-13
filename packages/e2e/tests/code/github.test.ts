import { describe, expect, test } from "bun:test";
import { GitHub } from "../../providers/github";
import { Scenario } from "../../helpers/scenario";

const enabled = process.env.DEVINTERN_E2E_GITHUB === "1";

describe.skipIf(!enabled)("GitHub built CLI E2E", () => {
  async function scenario(check: (run: Scenario) => Promise<void>): Promise<void> {
    const repository = process.env.E2E_GITHUB_REPOSITORY;
    const token = process.env.E2E_GITHUB_TOKEN;
    if (!repository || !token) throw new Error("Missing explicit E2E GitHub configuration");
    const run = new Scenario(new GitHub(repository, token));
    const errors: unknown[] = [];
    try {
      await run.setup(token);
      await check(run);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await run.cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, `GitHub scenario failed: ${run.id}`);
  }

  test("implements a Markdown task, pushes the commit and opens a PR against an explicit base", async () => {
    await scenario(async (run) => {
      await run.runCli();
      const pull = await run.github.waitForPull(run.head);
      expect(pull.state).toBe("open");
      expect(pull.head.ref).toBe(run.head);
      expect(pull.base.ref).toBe(run.base);
      expect(pull.title).toBe(`[${run.id}] Expand the greeting`);
      expect(pull.body).toContain("Hello, world!");
      expect(pull.head.sha).toBe(await run.git("rev-parse", "HEAD"));

      const files = await run.github.request<Array<{ filename: string; patch: string }>>(
        `/pulls/${pull.number}/files`,
      );
      expect(files.map((file) => file.filename)).toEqual(["src/greeting.ts"]);
      expect(files[0].patch).toContain('+export const greeting = "Hello, world!";');
      const comparison = await run.github.request<{ ahead_by: number }>(
        `/compare/${encodeURIComponent(run.base)}...${encodeURIComponent(run.head)}`,
      );
      expect(comparison.ahead_by).toBe(1);
      expect(await run.git("status", "--porcelain")).toBe("");
    });
  });

  test("applies PR_LABELS to the created pull request", async () => {
    await scenario(async (run) => {
      const label = "devintern-authored";
      await run.github.ensureLabel(label);
      await run.runCli(undefined, false, { prLabels: [label] });
      const pull = await run.github.waitForPull(run.head, run.base);
      expect(pull.labels.map((item) => item.name)).toContain(label);
    });
  });

  test("reports rejected PR credentials after pushing without creating a PR", async () => {
    await scenario(async (run) => {
      const result = await run.runCli("invalid-e2e-token");
      expect(result.stdout + result.stderr).toContain("GitHub PR creation failed");
      const ref = await run.github.request<{ object: { sha: string } }>(
        `/git/ref/heads/${encodeURIComponent(run.head)}`,
      );
      expect(ref.object.sha).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.github.pulls(run.head)).toEqual([]);
    });
  });
});
