import { describe, test } from "bun:test";
import { resolveGitHubConfig } from "../../helpers/github-config";
import { resolveGitLabComConfig } from "../../helpers/hosted-config";
import { withScenario } from "../../helpers/lifecycle";
import { assertTrackerLifecycle } from "../../helpers/tracker-lifecycle";
import { TrackerScenario, TRACKER_STATUS_SETTINGS } from "../../helpers/tracker-scenario";
import { GitHub } from "../../providers/github";
import { GitLab } from "../../providers/gitlab";
import type { GitLabProject } from "../../providers/gitlab";
import { GitLabTracker } from "../../providers/gitlab-tracker";

const enabled = process.env.DEVINTERN_E2E_GITLAB_COM_TRACKER === "1";

describe.skipIf(!enabled)("GitLab.com Issues tracker built CLI E2E", () => {
  for (const query of [false, true]) {
    test(`implements a hosted issue via ${query ? "--query" : "key"}, transitions statuses and opens a GitHub PR`, async () => {
      const gitlabConfig = resolveGitLabComConfig();
      const githubConfig = await resolveGitHubConfig();
      const gitlab = new GitLab("https://gitlab.com", gitlabConfig.token);
      const project = await gitlab.request<GitLabProject & { issues_enabled?: boolean }>(
        `/projects/${encodeURIComponent(gitlabConfig.projectPath)}`,
      );
      if (project.path_with_namespace !== gitlabConfig.projectPath) {
        throw new Error("GitLab.com returned an unexpected fixture project path");
      }
      if (project.issues_enabled !== true) {
        throw new Error("Enable Issues on the dedicated GitLab.com fixture project first");
      }
      const tracker = new GitLabTracker(
        gitlab,
        project,
        gitlabConfig.token,
        gitlab.baseUrl,
        Object.values(TRACKER_STATUS_SETTINGS),
        { deleteProject: false },
      );
      // The publication host stays GitHub; the GitLab.com project only hosts issues.
      const github = new GitHub(githubConfig.repository, githubConfig.token);
      const run = new TrackerScenario(github, tracker, {
        statuses: TRACKER_STATUS_SETTINGS,
      });

      await withScenario(run, githubConfig.token, async (scenario) => {
        await scenario.runTrackerCli({ query });
        await assertTrackerLifecycle(scenario);
      });
    });
  }
});
