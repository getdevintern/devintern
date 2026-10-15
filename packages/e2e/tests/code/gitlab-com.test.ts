import { describe, expect, test } from "bun:test";
import { GitLab } from "../../providers/gitlab";
import { GitLabComScenario } from "../../helpers/gitlab-com-scenario";
import { resolveGitLabComConfig } from "../../helpers/hosted-config";

describe.skipIf(process.env.DEVINTERN_E2E_GITLAB_COM !== "1")("GitLab.com built CLI E2E", () => {
  async function scenario(check: (run: GitLabComScenario) => Promise<void>): Promise<void> {
    const config = resolveGitLabComConfig();
    const run = new GitLabComScenario(
      new GitLab("https://gitlab.com", config.token),
      config.projectPath,
    );
    const errors: unknown[] = [];
    try {
      await run.setup(config.token);
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
    if (errors.length) throw new AggregateError(errors, `GitLab.com scenario failed: ${run.id}`);
  }

  test("implements a task, pushes the commit and opens an MR against an explicit target", async () => {
    await scenario(async (run) => {
      const result = await run.runCli();
      expect(result.stdout + result.stderr).toContain("Merge request created:");
      const mr = await run.gitlab.waitForMergeRequest(run.projectId(), run.head);
      expect(mr.state).toBe("opened");
      expect(mr.source_branch).toBe(run.head);
      expect(mr.target_branch).toBe(run.base);
      expect(mr.sha).toBe(await run.git("rev-parse", "HEAD"));
      expect(mr.title).toBe(`[${run.id}] Expand the greeting`);
      expect(mr.description).toContain("Hello, world!");
      const diffs = await run.gitlab.request<Array<{ new_path: string; diff: string }>>(
        `/projects/${run.projectId()}/merge_requests/${mr.iid}/diffs`,
      );
      expect(diffs.map((file) => file.new_path)).toEqual(["src/greeting.ts"]);
      expect(diffs[0].diff).toContain('+export const greeting = "Hello, world!";');
      const commits = await run.gitlab.request<unknown[]>(
        `/projects/${run.projectId()}/merge_requests/${mr.iid}/commits`,
      );
      expect(commits).toHaveLength(1);
      expect(await run.git("status", "--porcelain")).toBe("");
    });
  });

  test("reports invalid MR credentials after a successful push without opening an MR", async () => {
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
