import { describe, expect, test } from "bun:test";
import { GitLab } from "../../providers/gitlab";
import { GitLabScenario } from "../../helpers/gitlab-scenario";
import { assertCollision, assertUndelivered, withScenario } from "../../helpers/lifecycle";

interface ProjectToken {
  token: string;
  user_id: number;
}
interface Discussion {
  id: string;
  notes: Array<{ body: string; author: { id: number } }>;
}

describe.skipIf(process.env.DEVINTERN_E2E_GITLAB !== "1")("GitLab delivery lifecycle", () => {
  function scenario(check: (run: GitLabScenario) => Promise<void>) {
    const token = process.env.E2E_GITLAB_TOKEN;
    const url = process.env.E2E_GITLAB_URL;
    if (!token || !url) throw new Error("Missing GitLab E2E configuration");
    return withScenario(new GitLabScenario(new GitLab(url, token)), token, check);
  }
  function projectToken(run: GitLabScenario, scopes: string[], accessLevel: number) {
    return run.gitlab.request<ProjectToken>(`/projects/${run.projectId()}/access_tokens`, "POST", {
      name: `e2e-${accessLevel}`,
      scopes,
      access_level: accessLevel,
      expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    });
  }
  for (const agentMode of ["fail", "no-change"] as const) {
    test(`does not publish or report success when the agent returns ${agentMode}`, () =>
      scenario(async (run) => {
        const baseSha = await run.remoteSha(run.base);
        await run.runTask({ agentMode });
        expect(await run.gitlab.mergeRequests(run.projectId(), run.head)).toEqual([]);
        await assertUndelivered(run, baseSha);
      }));
  }
  test("preserves an existing remote branch and publishes a new attempt", () =>
    scenario(async (run) => {
      const head = await assertCollision(run);
      const mr = await run.gitlab.waitForMergeRequest(run.projectId(), head);
      expect(mr.target_branch).toBe(run.base);
      expect(mr.sha).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.gitlab.mergeRequests(run.projectId(), run.head)).toEqual([]);
    }));
  test("records failure when Git rejects the push, before attempting MR creation", () =>
    scenario(async (run) => {
      const baseSha = await run.remoteSha(run.base);
      const token = await projectToken(run, ["read_repository"], 20);
      const result = await run.runTask({ gitToken: token.token });
      expect(result.stdout + result.stderr).toContain("Cannot create PR without pushing");
      expect(await run.git("rev-parse", "HEAD")).not.toBe(baseSha);
      expect(await run.gitlab.mergeRequests(run.projectId(), run.head)).toEqual([]);
      await assertUndelivered(run, baseSha);
      expect(run.runRecords()[0].outcome_reason).toContain("Push failed");
    }));
  test("addresses real human feedback on the same MR and deduplicates a second invocation", () =>
    scenario(async (run) => {
      const baseSha = await run.remoteSha(run.base);
      const bot = await projectToken(run, ["api"], 30);
      run.env.GITLAB_CODE_HOST_TOKEN = bot.token;
      run.env.E2E_GIT_TOKEN = bot.token;
      await run.runCli();
      const mr = await run.gitlab.waitForMergeRequest(run.projectId(), run.head);
      const path = `/projects/${run.projectId()}/merge_requests/${mr.iid}`;
      const discussion = await run.gitlab.request<Discussion>(`${path}/discussions`, "POST", {
        body: 'Change the greeting to "Hello, reviewer!" and run the tests. E2E_REVIEW_GREETING',
      });
      expect(discussion.notes[0].author.id).not.toBe(bot.user_id);
      const url = `${run.gitlab.baseUrl}/${run.project!.path_with_namespace}/-/merge_requests/${mr.iid}`;
      const first = await run.runReview(url);
      expect({ exitCode: first.exitCode, output: first.stdout + first.stderr }).toEqual({
        exitCode: 0,
        output: expect.any(String),
      });
      const updated = await run.gitlab.waitForMergeRequest(
        run.projectId(),
        run.head,
        await run.remoteSha(run.head),
      );
      expect(updated.sha).not.toBe(mr.sha);
      expect(await run.remoteSha(run.head)).toBe(updated.sha);
      const file = await run.gitlab.request<{ content: string }>(
        `/projects/${run.projectId()}/repository/files/src%2Fgreeting.ts?ref=${encodeURIComponent(run.head)}`,
      );
      expect(Buffer.from(file.content, "base64").toString()).toBe(
        'export const greeting = "Hello, reviewer!";\n',
      );
      const after = await run.gitlab.request<Discussion>(`${path}/discussions/${discussion.id}`);
      expect(
        after.notes.some(
          (note) => note.author.id === bot.user_id && note.body.includes("Addressed this feedback"),
        ),
      ).toBe(true);
      const second = await run.runReview(url);
      expect(second.exitCode).toBe(0);
      expect(second.stdout + second.stderr).toContain("already");
      expect(await run.remoteSha(run.head)).toBe(updated.sha);
      expect(
        (await run.gitlab.request<Discussion>(`${path}/discussions/${discussion.id}`)).notes,
      ).toHaveLength(after.notes.length);
      expect(await run.gitlab.request<unknown[]>(`${path}/commits`)).toHaveLength(2);
      expect(await run.gitlab.mergeRequests(run.projectId(), run.head)).toHaveLength(1);
      expect(run.agentInvocations().map((item) => item.mode)).toEqual(["implement", "review"]);
      expect(await run.remoteSha(run.base)).toBe(baseSha);
    }));
});
