import { describe, test } from "bun:test";
import { withScenario } from "../../helpers/lifecycle";
import { resolveGitHubTrackerConfig } from "../../helpers/tracker-config";
import { assertTrackerLifecycle } from "../../helpers/tracker-lifecycle";
import { TrackerScenario, TRACKER_STATUS_SETTINGS } from "../../helpers/tracker-scenario";
import { GitHub } from "../../providers/github";
import { GitHubTracker } from "../../providers/github-tracker";

const enabled = process.env.DEVINTERN_E2E_GITHUB_TRACKER === "1";

describe.skipIf(!enabled)("GitHub Issues tracker built CLI E2E", () => {
  test("implements a remote ticket, delivers markers, transitions statuses, selects by query and opens a PR", async () => {
    const config = resolveGitHubTrackerConfig();
    // The initial tracker/provider pairing shares the GitHub code host and token.
    const github = new GitHub(config.repository, config.token);
    // The scenario adds its own exclusive labels to any operator-configured set.
    const tracker = new GitHubTracker(config.repository, config.token, config.statusLabels);
    const run = new TrackerScenario(github, tracker, {
      statuses: TRACKER_STATUS_SETTINGS,
    });

    await withScenario(run, config.token, async (scenario) => {
      await scenario.runTrackerCli();
      await assertTrackerLifecycle(scenario);
    });
  });
});
