/**
 * Integration coverage for the official DeepSeek Harness (`dsh`) adapter.
 *
 * A fake `dsh` stands in for the real CLI so the full Code path runs for real:
 * version probe -> `headless` argv -> spawn -> captured output. It covers a
 * successful implementation, missing install, credential/auth failures, and an
 * interrupted (timed-out) run without requiring a DeepSeek account.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarness, runAgentNode } from "@devintern/agent-harness";
import { detectHarnessStartupFailure } from "../src/lib/agent/harness-startup";

const FAKE_DSH = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "0.2.1-rc.2"
  exit 0
fi
mode="\${FAKE_DSH_MODE:-success}"
case "$mode" in
  missing-credential)
    echo "dsh: MISSING_CREDENTIAL: no credential for provider deepseek" >&2
    exit 2
    ;;
  unauthorized)
    echo "dsh: UNAUTHORIZED: provider rejected the API key" >&2
    exit 2
    ;;
  hang)
    sleep 10
    exit 0
    ;;
  fail)
    echo "implementation failed on purpose" >&2
    exit 17
    ;;
esac
echo "implemented by fake dsh" > implemented.txt
cat <<'EOF'
<!-- devintern:summary:start -->
## Why
The fixture needs the requested behavior.
## What changed
Fake dsh wrote implemented.txt.
## Scope
The implementation fixture only.
## Tradeoffs
None.
## Blast Radius
The fixture file.
## Verification
Fake dsh exited successfully.
<!-- devintern:summary:end -->
EOF
`;

let root: string;
let cwd: string;
let cli: string;
const originalMode = process.env.FAKE_DSH_MODE;
const originalRetries = process.env.AGENT_SPAWN_ENOENT_RETRIES;
const originalBackoff = process.env.AGENT_SPAWN_ENOENT_BACKOFF_MS;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devintern-dsh-code-"));
  cwd = join(root, "repo");
  cli = join(root, "dsh");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(cli, FAKE_DSH);
  chmodSync(cli, 0o755);
  process.env.AGENT_SPAWN_ENOENT_RETRIES = "1";
  process.env.AGENT_SPAWN_ENOENT_BACKOFF_MS = "1";
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [
    ["FAKE_DSH_MODE", originalMode],
    ["AGENT_SPAWN_ENOENT_RETRIES", originalRetries],
    ["AGENT_SPAWN_ENOENT_BACKOFF_MS", originalBackoff],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("official DeepSeek Harness Code workflow", () => {
  test("completes a non-interactive implementation and returns its summary", async () => {
    const result = await runAgentNode(new DeepSeekHarness(), cli, "Implement the fixture", {
      cwd,
      silent: true,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "implemented.txt"), "utf8")).toContain("implemented by fake dsh");
    expect(result.stdout).toContain("<!-- devintern:summary:start -->");
    expect(result.stdout).toContain("Fake dsh wrote implemented.txt.");
    expect(result.stderr).toBe("");
  });

  test("surfaces a missing dsh install with install guidance", async () => {
    await expect(
      runAgentNode(new DeepSeekHarness(), join(root, "missing-dsh"), "Implement", {
        cwd,
        silent: true,
      }),
    ).rejects.toThrow(/CLI not found/);
    expect(existsSync(join(cwd, "implemented.txt"))).toBe(false);
  });

  test("classifies missing credentials and rejected auth as startup failures", async () => {
    for (const mode of ["missing-credential", "unauthorized"]) {
      process.env.FAKE_DSH_MODE = mode;
      const result = await runAgentNode(new DeepSeekHarness(), cli, "Implement", {
        cwd,
        silent: true,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("dsh:");
      const startup = detectHarnessStartupFailure({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: 50,
      });
      expect(startup?.unavailable).toBe(true);
      expect(startup?.reason).toContain(
        mode === "missing-credential" ? "MISSING_CREDENTIAL" : "UNAUTHORIZED",
      );
    }
  });

  test("returns an ordinary task failure with its exit code", async () => {
    process.env.FAKE_DSH_MODE = "fail";
    const result = await runAgentNode(new DeepSeekHarness(), cli, "Implement", {
      cwd,
      silent: true,
    });
    expect(result.exitCode).toBe(17);
    expect(result.stderr).toContain("implementation failed on purpose");
    expect(
      detectHarnessStartupFailure({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: 3_000,
      }),
    ).toBeNull();
  });

  test("reports an interrupted run as a timeout", async () => {
    process.env.FAKE_DSH_MODE = "hang";
    await expect(
      runAgentNode(new DeepSeekHarness(), cli, "Implement", {
        cwd,
        silent: true,
        timeoutMinutes: 0.002,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
