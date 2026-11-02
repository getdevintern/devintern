/**
 * Opt-in live smoke test for the official DeepSeek Harness (Code path).
 *
 * The normal suite stubs `dsh`; this one talks to the pinned real CLI so a
 * release check can verify the headless contract (credentials, argv, stdout)
 * without making every CI run depend on a DeepSeek account. Enable it with:
 *
 *   DSH_LIVE_TEST=1 DEEPSEEK_API_KEY=... bun run test deepseek-live-smoke
 *
 * `DSH_CLI_PATH` may point at a non-PATH install of `dsh`.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { DeepSeekHarness } from "@devintern/agent-harness";
import { buildHeadlessAgentInvocation } from "../src/lib/agent/spawn";

const live = process.env.DSH_LIVE_TEST === "1" && Boolean(process.env.DEEPSEEK_API_KEY);
const liveTest = live ? test : test.skip;

describe("live official DeepSeek Harness (Code)", () => {
  liveTest(
    "runs a trivial headless task through the Code invocation path",
    async () => {
      const cli = process.env.DSH_CLI_PATH ?? "dsh";
      const invocation = await buildHeadlessAgentInvocation(
        new DeepSeekHarness(),
        cli,
        "Reply with exactly: OK",
        { silent: true },
      );
      expect(invocation.args[0]).toBe("headless");

      const result = spawnSync(cli, invocation.args, {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ...invocation.env },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("OK");
    },
    130_000,
  );
});
