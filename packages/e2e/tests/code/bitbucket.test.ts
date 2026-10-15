import { describe, expect, test } from "bun:test";
import { Bitbucket } from "../../providers/bitbucket";
import { BitbucketScenario } from "../../helpers/bitbucket-scenario";
import { resolveBitbucketConfig } from "../../helpers/hosted-config";

describe.skipIf(process.env.DEVINTERN_E2E_BITBUCKET !== "1")(
  "Bitbucket Cloud built CLI E2E",
  () => {
    async function scenario(check: (run: BitbucketScenario) => Promise<void>): Promise<void> {
      const config = resolveBitbucketConfig();
      const run = new BitbucketScenario(new Bitbucket(config.repository, config.token));
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
      if (errors.length) throw new AggregateError(errors, `Bitbucket scenario failed: ${run.id}`);
    }

    test("implements a task, pushes the commit and opens a PR against an explicit target", async () => {
      await scenario(async (run) => {
        const result = await run.runCli();
        expect(result.stdout + result.stderr).toContain("Pull request created:");
        const pull = await run.bitbucket.waitForPull(run.head);
        expect(pull.state).toBe("OPEN");
        expect(pull.source.branch.name).toBe(run.head);
        expect(pull.destination.branch.name).toBe(run.base);
        expect(pull.source.commit.hash).toBe(await run.git("rev-parse", "HEAD"));
        expect(pull.title).toBe(`[${run.id}] Expand the greeting`);
        expect(pull.description).toContain("Hello, world!");
        const files = await run.bitbucket.list<{ new: { path: string } }>(
          `/pullrequests/${pull.id}/diffstat`,
        );
        expect(files.map((file) => file.new.path)).toEqual(["src/greeting.ts"]);
        expect(await run.bitbucket.diff(pull.id)).toContain(
          '+export const greeting = "Hello, world!";',
        );
        const commits = await run.bitbucket.list(`/pullrequests/${pull.id}/commits`);
        expect(commits).toHaveLength(1);
        expect(await run.git("status", "--porcelain")).toBe("");
      });
    });

    test("reports invalid PR credentials after a successful push without opening a PR", async () => {
      await scenario(async (run) => {
        const result = await run.runCli("invalid-e2e-token");
        expect(result.stdout + result.stderr).toContain("Bitbucket PR creation failed");
        const branch = await run.bitbucket.request<{ target: { hash: string } }>(
          `/refs/branches/${encodeURIComponent(run.head)}`,
        );
        expect(branch.target.hash).toBe(await run.git("rev-parse", "HEAD"));
        expect(await run.bitbucket.pulls(run.head)).toEqual([]);
      });
    });
  },
);
