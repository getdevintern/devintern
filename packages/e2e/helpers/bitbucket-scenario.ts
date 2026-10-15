import { Bitbucket } from "../providers/bitbucket";
import { FixtureWorkspace } from "./fixture-workspace";

export class BitbucketScenario extends FixtureWorkspace {
  private prepared = false;

  constructor(readonly bitbucket: Bitbucket) {
    super("BITBUCKET_TOKEN");
  }

  async setup(token: string): Promise<void> {
    const repo = await this.bitbucket.request<{ mainbranch?: { name: string } }>("");
    if (!repo.mainbranch?.name)
      throw new Error(
        "Initialize the dedicated Bitbucket fixture repository with a default branch first",
      );
    this.prepared = true;
    await this.prepare(
      `https://bitbucket.org/${this.bitbucket.repository}.git`,
      token,
      { BITBUCKET_TOKEN: token },
      "x-token-auth",
    );
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    if (this.prepared) {
      try {
        for (const pull of await this.bitbucket.pulls(this.head)) {
          if (pull.source.branch.name !== this.head)
            throw new Error("Bitbucket returned a PR for an unexpected source branch");
          if (pull.state === "OPEN") {
            try {
              await this.bitbucket.request(`/pullrequests/${pull.id}/decline`, "POST");
            } catch (error) {
              errors.push(error);
            }
          }
        }
      } catch (error) {
        errors.push(error);
      }
      for (const branch of [this.head, this.base]) {
        try {
          await this.deleteRemoteBranch(branch);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.dispose();
    if (errors.length) throw new AggregateError(errors, `Bitbucket cleanup failed for ${this.id}`);
  }
}
