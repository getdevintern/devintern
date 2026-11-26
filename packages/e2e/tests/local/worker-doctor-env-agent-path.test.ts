/**
 * `devintern worker doctor` with the agent CLI path configured only in the
 * workspace `.env` (not the process environment or PATH): the harness row
 * must resolve it the way the worker's task subprocess does, and a bad path
 * must be named with the file that set it
 * (`packages/code/src/lib/observability/harness-readiness.ts`).
 */

import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliPath, WorkerFixture } from "../../helpers/worker";

const builtCli = existsSync(cliPath);

test.skipIf(!builtCli)(
  "worker doctor finds an agent CLI path set only in the workspace .env",
  async () => {
    const worker = new WorkerFixture({ rootPrefix: "devintern-e2e-doctor-env-agent-" });
    try {
      await worker.prepare();
      const agent = worker.env.AGENT_CLI_PATH;
      expect(agent).toBeTruthy();
      // Only the workspace .env names the agent from here on.
      delete worker.env.AGENT_CLI_PATH;
      const envPath = join(worker.workspaceDir, ".env");

      writeFileSync(envPath, `AGENT_CLI_PATH=${agent}\n`, { mode: 0o600 });
      const ready = await worker.runCli(["worker", "doctor", "--offline"]);
      expect(ready.stdout).toContain("✅ Agent harness — claude-code");

      const bogus = join(worker.root, "no-such-agent");
      writeFileSync(envPath, `AGENT_CLI_PATH=${bogus}\n`, { mode: 0o600 });
      const broken = await worker.runCli(["worker", "doctor", "--offline"]);
      expect(broken.exitCode).toBe(1);
      expect(broken.stdout).toContain(
        `❌ Agent harness — claude-code: AGENT_CLI_PATH=${bogus} (set in ${envPath}) does not exist`,
      );
    } finally {
      await worker.dispose();
    }
  },
  60_000,
);
