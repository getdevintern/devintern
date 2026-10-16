import { describe, expect, test } from "bun:test";
import { withScenario } from "../../helpers/lifecycle";
import { resolveGitHubTrackerConfig } from "../../helpers/tracker-config";
import { TrackerScenario } from "../../helpers/tracker-scenario";
import { GitHub } from "../../providers/github";
import { GitHubTracker } from "../../providers/github-tracker";

const enabled = process.env.DEVINTERN_E2E_GITHUB_TRACKER === "1";

describe.skipIf(!enabled)("GitHub Issues tracker built CLI E2E", () => {
  test("implements a remote ticket, delivers the seeded description and comment markers, and opens a PR", async () => {
    const config = resolveGitHubTrackerConfig();
    // The initial tracker/provider pairing shares the GitHub code host and token.
    const github = new GitHub(config.repository, config.token);
    const tracker = new GitHubTracker(config.repository, config.token, config.statusLabels);
    const run = new TrackerScenario(github, tracker, { seedComment: true });

    await withScenario(run, config.token, async (scenario) => {
      await scenario.runTrackerCli();
      const pull = await scenario.github.waitForPull(scenario.head);
      expect(pull.state).toBe("open");
      expect(pull.head.ref).toBe(scenario.head);
      expect(pull.base.ref).toBe(scenario.base);
      expect(pull.title).toBe(`[${scenario.taskKey}] Expand the greeting`);
      expect(pull.body).toContain("Hello, world!");
      expect(scenario.taskKey).toBe(scenario.ticket?.key ?? "");

      const files = await scenario.github.request<Array<{ filename: string; patch: string }>>(
        `/pulls/${pull.number}/files`,
      );
      expect(files.map((file) => file.filename)).toEqual(["src/greeting.ts"]);

      // Tracker feedback reaches the ticket and the run is recorded under the
      // real tracker key rather than a synthetic Markdown key. The seeded
      // comment is still present until cleanup removes it.
      const comments = await scenario.github.request<Array<{ body: string }>>(
        `/issues/${scenario.taskKey}/comments`,
      );
      expect(comments.some((comment) => comment.body.includes(scenario.commentMarker))).toBe(true);
      expect(comments.some((comment) => comment.body.includes("Updated src/greeting.ts"))).toBe(
        true,
      );
      expect(scenario.runRecords().map((record) => record.status)).toEqual(["succeeded"]);
    });
  });
});
