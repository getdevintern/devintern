/**
 * A conflict-resolution job pinned to one harness opts out of failover, so the
 * child's usage-limit hint is the only source for its real reset time. Without
 * it the worker retries the pinned harness every few minutes while it is still
 * limited.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runResolveConflictsViaCli } from "../src/lib/acquirers/review-cli";
import { USAGE_LIMIT_EXIT_CODE } from "../src/lib/worker/usage-limit-protocol";

const CHILD_SCRIPT = `
import { appendFileSync, writeFileSync } from "node:fs";

appendFileSync(process.env.STATE_FILE, \`\${process.env.AGENT_HARNESS}\\n\`);
writeFileSync(
  process.env.DEVINTERN_USAGE_LIMIT_FILE,
  JSON.stringify({ untilMs: Number(process.env.RESET_AT) }),
);
process.exit(${USAGE_LIMIT_EXIT_CODE});
`;

describe("runResolveConflictsViaCli with a pinned harness", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("defers until the pinned harness's reported reset time", async () => {
    dir = mkdtempSync(join(tmpdir(), "resolve-pinned-limit-"));
    const script = join(dir, "child.ts");
    const statePath = join(dir, "calls.txt");
    writeFileSync(script, CHILD_SCRIPT);
    const resetAt = Date.now() + 3_600_000;

    const result = await runResolveConflictsViaCli("acme/widgets", 7, {
      entrypoint: script,
      harnessPin: "claude-code",
      env: { ...process.env, STATE_FILE: statePath, RESET_AT: String(resetAt) },
    });

    expect(result.outcome).toBe("deferred");
    expect(result.capacity).toBe(true);
    expect(result.retryAt).toBe(resetAt);
    expect(readFileSync(statePath, "utf8").trim().split("\n")).toEqual(["claude-code"]);
  });
});
