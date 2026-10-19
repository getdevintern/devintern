import { GitHub } from "../providers/github";
import { collectGitHubCleanupFailures, throwCleanupFailures } from "./cleanup";
import { FixtureWorkspace } from "./fixture-workspace";

export { cliPath } from "./fixture-workspace";

export class Scenario extends FixtureWorkspace {
  constructor(readonly github: GitHub) {
    super();
  }

  async setup(token: string): Promise<void> {
    await this.github.request("");
    await this.prepare(`https://github.com/${this.github.repository}.git`, token, {
      GITHUB_TOKEN: token,
    });
  }

  async cleanup(): Promise<void> {
    // Attempt every cleanup even if a preceding operation fails.
    const failures = await collectGitHubCleanupFailures(this.github, this.ownedBranches, this.base);
    this.dispose();
    throwCleanupFailures(
      `Cleanup failed for ${this.id}; inspect ${this.head} and ${this.base}`,
      failures,
    );
  }
}
