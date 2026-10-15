import { GitHub } from "../providers/github";
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
    const errors: unknown[] = [];
    for (const head of [...this.ownedBranches].filter((branch) => branch !== this.base)) {
      try {
        const pulls = await this.github.pulls(head);
        for (const pull of pulls.filter((item) => item.state === "open")) {
          try {
            await this.github.request(`/pulls/${pull.number}`, "PATCH", { state: "closed" });
          } catch (error) {
            errors.push(error);
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }
    for (const branch of this.ownedBranches) {
      try {
        await this.github.deleteBranch(branch);
      } catch (error) {
        errors.push(error);
      }
    }
    this.dispose();
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Cleanup failed for ${this.id}; inspect ${this.head} and ${this.base}`,
      );
    }
  }
}
