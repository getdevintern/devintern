/**
 * Opt-in live smoke test for the official DeepSeek Harness (PM story path).
 *
 * The normal suite stubs `dsh`; this one talks to the pinned real CLI so a
 * release check can verify story drafting end to end. Enable it with:
 *
 *   DSH_LIVE_TEST=1 DEEPSEEK_API_KEY=... bun test dsh-live-smoke
 *
 * `DSH_CLI_PATH` may point at a non-PATH install of `dsh`.
 */

import { describe, expect, test } from "bun:test";
import { DeepSeekHarness } from "@devintern/agent-harness";
import { runAgent } from "./lib/agent";

const live = process.env.DSH_LIVE_TEST === "1" && Boolean(process.env.DEEPSEEK_API_KEY);
const liveTest = live ? test : test.skip;

describe("live official DeepSeek Harness (PM)", () => {
  liveTest(
    "drafts a trivial story non-interactively",
    async () => {
      const result = await runAgent(
        new DeepSeekHarness(),
        process.env.DSH_CLI_PATH ?? "dsh",
        "Reply with exactly: OK",
        { workingDir: process.cwd(), silent: true },
      );
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("OK");
    },
    130_000,
  );
});
