import { describe, expect, test } from "bun:test";

import { UsageLimitError } from "../src/detect-usage-limit.js";
import { runAgentBun } from "../src/runners/bun.js";
import { runAgentNode } from "../src/runners/node.js";
import type { AgentHarness } from "../src/types.js";

const OPENCODE_LIMIT_LOG =
  'timestamp=2026-08-26T14:10:30.957Z level=ERROR message="stream error" error.error="AI_APICallError: 5-hour usage limit reached. Resets in 4hr 9min."';

const hangingHarness: AgentHarness = {
  name: "test-hanging-limit",
  displayName: "Hanging limit test",
  defaultPath: "/bin/sh",
  buildArgs: () => ["-c", `printf '%s\\n' '${OPENCODE_LIMIT_LOG}' >&2; sleep 300`],
};

describe("runner streaming usage-limit detection", () => {
  test(
    "Node runner terminates a process that logs a limit without exiting",
    async () => {
      const startedAt = Date.now();
      await expect(
        runAgentNode(hangingHarness, "/bin/sh", "ignored", {
          silent: true,
          timeoutMinutes: 1,
        }),
      ).rejects.toBeInstanceOf(UsageLimitError);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    },
    10_000,
  );

  test(
    "Bun runner terminates a process that logs a limit without exiting",
    async () => {
      const startedAt = Date.now();
      await expect(
        runAgentBun(hangingHarness, "/bin/sh", "ignored", { silent: true }),
      ).rejects.toBeInstanceOf(UsageLimitError);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    },
    10_000,
  );
});
