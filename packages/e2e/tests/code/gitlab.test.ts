import { describe, expect, test } from "bun:test";
import { GitLab } from "../../providers/gitlab";
import { GitLabScenario } from "../../helpers/gitlab-scenario";

describe.skipIf(process.env.DEVINTERN_E2E_GITLAB !== "1")("GitLab built CLI E2E", () => {
  async function scenario(check: (run: GitLabScenario) => Promise<void>): Promise<void> {
    const baseUrl = process.env.E2E_GITLAB_URL;
    const token = process.env.E2E_GITLAB_TOKEN;
    if (!baseUrl || !token) throw new Error("Missing explicit GitLab E2E configuration");
    const run = new GitLabScenario(new GitLab(baseUrl, token));
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
    if (errors.length)
      throw new AggregateError(
        errors,
        `GitLab scenario failed: ${run.id}; project ${run.project?.id ?? "not created"}`,
      );
  }

  test("implements a Markdown task, pushes the commit and opens a merge request", async () => {
    await scenario(async (run) => {
      const result = await run.runCli();
      expect(result.stdout + result.stderr).toContain("Merge request created:");
      const mr = await run.gitlab.waitForMergeRequest(run.projectId(), run.head);
      expect(mr.state).toBe("opened");
      expect(mr.source_branch).toBe(run.head);
      expect(mr.target_branch).toBe(run.base);
      expect(mr.title).toBe(`[${run.id}] Expand the greeting`);
      expect(mr.description).toContain("Hello, world!");
      expect(mr.sha).toBe(await run.git("rev-parse", "HEAD"));
      const diffs = await run.gitlab.request<Array<{ new_path: string; diff: string }>>(
        `/projects/${run.projectId()}/merge_requests/${mr.iid}/diffs`,
      );
      expect(diffs.map((item) => item.new_path)).toEqual(["src/greeting.ts"]);
      expect(diffs[0].diff).toContain('+export const greeting = "Hello, world!";');
      const commits = await run.gitlab.request<unknown[]>(
        `/projects/${run.projectId()}/merge_requests/${mr.iid}/commits`,
      );
      expect(commits).toHaveLength(1);
      expect(await run.git("status", "--porcelain")).toBe("");
    });
  });

  test("uses the project's nonstandard default branch when no target is supplied", async () => {
    await scenario(async (run) => {
      const result = await run.runCli(undefined, true);
      expect(result.stdout + result.stderr).toContain("Merge request created:");
      const mr = await run.gitlab.waitForMergeRequest(run.projectId(), run.head);
      expect(mr.target_branch).toBe(run.base);
      expect(mr.sha).toBe(await run.git("rev-parse", "HEAD"));
    });
  });

  test("reports invalid API credentials after a successful push without creating a merge request", async () => {
    await scenario(async (run) => {
      const result = await run.runCli("invalid-e2e-token");
      expect(result.stdout + result.stderr).toContain("GitLab MR creation failed");
      const branch = await run.gitlab.request<{ commit: { id: string } }>(
        `/projects/${run.projectId()}/repository/branches/${encodeURIComponent(run.head)}`,
      );
      expect(branch.commit.id).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.gitlab.mergeRequests(run.projectId(), run.head)).toEqual([]);
    });
  });
});
