/**
 * CI repair is a worker agent job: it must run on the failover chain's active
 * harness and defer (not burn the PR's retry budget) when every harness is
 * usage-limited.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runCiFixViaCli } from "../src/lib/acquirers/ci-failure-watcher";
import { resetWorkerFailover, startWorkerFailover } from "../src/lib/worker/failover";
import { USAGE_LIMIT_EXIT_CODE } from "../src/lib/worker/usage-limit-protocol";

const CHILD_SCRIPT = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.STATE_FILE;
const prior = (() => {
  try {
    return readFileSync(statePath, "utf8").trim().split("\\n").filter(Boolean);
  } catch {
    return [];
  }
})();
appendFileSync(statePath, \`\${process.env.AGENT_HARNESS}\\n\`);
if (prior.length === 0) {
  writeFileSync(
    process.env.DEVINTERN_USAGE_LIMIT_FILE,
    JSON.stringify({ untilMs: Date.now() + 60_000 }),
  );
  process.exit(${USAGE_LIMIT_EXIT_CODE});
}
process.exit(0);
`;

describe("runCiFixViaCli harness failover", () => {
  const originalArgv1 = process.argv[1];
  let dir: string;

  afterEach(() => {
    resetWorkerFailover();
    process.argv[1] = originalArgv1;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeChild(): string {
    dir = mkdtempSync(join(tmpdir(), "ci-fix-failover-"));
    const script = join(dir, "child.ts");
    const statePath = join(dir, "calls.txt");
    writeFileSync(script, CHILD_SCRIPT);
    process.argv[1] = script;
    return statePath;
  }

  test("retries on the next harness after a usage limit", async () => {
    const statePath = writeChild();
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex,grok",
      log: () => {},
    });

    const result = await runCiFixViaCli("acme/widgets", 7, join(dir, "feedback.json"), {
      env: { ...process.env, STATE_FILE: statePath },
    });

    expect(result).toBe(true);
    expect(readFileSync(statePath, "utf8").trim().split("\n")).toEqual(["codex", "grok"]);
  });

  test("defers instead of failing when every harness is limited", async () => {
    const statePath = writeChild();
    await startWorkerFailover({
      checkInstalled: false,
      sandboxName: "none",
      raw: "codex",
      log: () => {},
    });

    const result = await runCiFixViaCli("acme/widgets", 7, join(dir, "feedback.json"), {
      env: { ...process.env, STATE_FILE: statePath },
    });

    expect(result).toBe("deferred");
    expect(readFileSync(statePath, "utf8").trim().split("\n")).toEqual(["codex"]);
  });
});
