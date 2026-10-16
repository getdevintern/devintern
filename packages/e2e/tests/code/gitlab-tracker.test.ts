import { describe, test } from "bun:test";
import { resolveGitHubConfig } from "../../helpers/github-config";
import { resolveGitLabConfig } from "../../helpers/gitlab-config";
import { withScenario } from "../../helpers/lifecycle";
import { assertTrackerLifecycle } from "../../helpers/tracker-lifecycle";
import { TrackerScenario, TRACKER_STATUS_SETTINGS } from "../../helpers/tracker-scenario";
import { GitLab } from "../../providers/gitlab";
import { GitLabTracker } from "../../providers/gitlab-tracker";
import { GitHub } from "../../providers/github";

const enabled = process.env.DEVINTERN_E2E_GITLAB_TRACKER === "1";

describe.skipIf(!enabled)("local GitLab Issues tracker built CLI E2E", () => {
  for (const query of [false, true]) {
    test(`implements a local issue via ${query ? "--query" : "key"}, transitions statuses and opens a GitHub PR`, async () => {
      const gitlabConfig = resolveGitLabConfig();
      // The publication host is GitHub (possibly a separate fixture repository
      // from the GitLab tracker project); the tracker source stays local.
      const githubConfig = await resolveGitHubConfig();
      const gitlab = new GitLab(gitlabConfig.baseUrl, gitlabConfig.token);
      const project = await gitlab.createProject(`e2e-${crypto.randomUUID()}`);
      const tracker = new GitLabTracker(
        gitlab,
        project,
        gitlabConfig.token,
        gitlabConfig.baseUrl,
        Object.values(TRACKER_STATUS_SETTINGS),
      );
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
