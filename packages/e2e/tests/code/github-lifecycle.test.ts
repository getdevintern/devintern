import { describe, expect, test } from "bun:test";
import { GitHub } from "../../providers/github";
import { Scenario } from "../../helpers/scenario";
import { assertCollision, assertUndelivered, withScenario } from "../../helpers/lifecycle";

describe.skipIf(process.env.DEVINTERN_E2E_GITHUB !== "1")("GitHub delivery lifecycle", () => {
  function scenario(check: (run: Scenario) => Promise<void>) {
    const token = process.env.E2E_GITHUB_TOKEN;
    const repository = process.env.E2E_GITHUB_REPOSITORY;
    if (!token || !repository) throw new Error("Missing GitHub E2E configuration");
    return withScenario(new Scenario(new GitHub(repository, token)), token, check);
  }
  for (const agentMode of ["fail", "no-change"] as const) {
    test(`does not publish or report success when the agent returns ${agentMode}`, () =>
      scenario(async (run) => {
        const baseSha = await run.remoteSha(run.base);
        await run.runTask({ agentMode });
        expect(await run.github.pulls(run.head)).toEqual([]);
        await assertUndelivered(run, baseSha);
      }));
  }
  test("preserves an existing remote branch and publishes a new attempt", () =>
    scenario(async (run) => {
      const head = await assertCollision(run);
      const pull = await run.github.waitForPull(head);
      expect(pull.base.ref).toBe(run.base);
      expect(pull.head.sha).toBe(await run.git("rev-parse", "HEAD"));
      expect(await run.github.pulls(run.head)).toEqual([]);
    }));
});
