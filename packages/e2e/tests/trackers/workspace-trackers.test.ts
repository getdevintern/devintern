import { describe, expect, test } from "bun:test";
import { detectTrackers, getActiveTrackerId } from "../../helpers/tracker-smoke";
import { mergeWorkspaceEnv, readWorkspaceEnv } from "../../helpers/workspace-env";

const enabled = process.env.DEVINTERN_E2E_TRACKERS === "1";

if (!enabled) {
  describe("workspace tracker smoke", () => {
    test.skip("set DEVINTERN_E2E_TRACKERS=1 or run `test:trackers`", () => {});
  });
} else {
  const workspaceEnv = readWorkspaceEnv();
  const env = mergeWorkspaceEnv(workspaceEnv.values);
  const activeTracker = getActiveTrackerId(env);
  const candidates = detectTrackers(env);
  const configured = candidates.filter((candidate) => candidate.configured);
  const supported = configured.filter((candidate) => candidate.check.run !== undefined);
  const unsupported = configured.filter((candidate) => candidate.check.run === undefined);
  const activeCandidate = candidates.find((candidate) => candidate.check.id === activeTracker);

  describe(`workspace tracker smoke (${workspaceEnv.path})`, () => {
    test("the active tracker is configured", () => {
      if (!activeCandidate) {
        throw new Error(`TASK_TRACKER=${activeTracker} is not a supported tracker id`);
      }
      expect(activeCandidate.missing).toEqual([]);
    });

    test("at least one configured tracker has a read-only check", () => {
      if (supported.length === 0) {
        throw new Error(
          `No read-only check is implemented for configured trackers: ${
            configured.map((candidate) => candidate.check.id).join(", ") || "none"
          }`,
        );
      }
      expect(supported.length).toBeGreaterThan(0);
    });

    if (unsupported.length > 0) {
      test.skip(`read-only checks are not implemented yet for: ${unsupported
        .map((candidate) => candidate.check.id)
        .join(", ")}`, () => {});
    }

    for (const candidate of supported) {
      const run = candidate.check.run;
      if (!run) continue;
      test(`${candidate.check.displayName} is reachable and coherent`, async () => {
        const result = await run(env);
        for (const detail of result.details) console.log(`   ${detail}`);
        console.log(`✅ ${result.summary}`);
      }, 60_000);
    }
  });
}
