/**
 * Integration coverage for the official DeepSeek Harness (`dsh`) in the PM
 * story workflow.
 *
 * A fake `dsh` runs through the same `runAgent` wrapper devpm uses for story
 * generation, so version probing, `headless` argv, spawn, stdout capture, and
 * the tolerant JSON parser are all exercised without a DeepSeek account.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarness } from "@devintern/agent-harness";
import { runAgent } from "./lib/agent";
import { parseAgentJson } from "./lib/agent-json";

const FAKE_DSH = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "0.2.1-rc.2"
  exit 0
fi
mode="\${FAKE_DSH_MODE:-story}"
if [ "$mode" = "missing-credential" ]; then
  echo "dsh: MISSING_CREDENTIAL: no credential for provider deepseek" >&2
  exit 2
fi
cat <<'EOF'
{"summary":"Add a deterministic greeting","description":"## Overview\\n\\nReturn a stable greeting so the fixture is testable.\\n\\n## Acceptance Criteria\\n\\n- The greeting is constant.\\n"}
EOF
`;

let root: string;
let cli: string;
const originalMode = process.env.FAKE_DSH_MODE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devintern-dsh-pm-"));
  cli = join(root, "dsh");
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(cli, FAKE_DSH);
  chmodSync(cli, 0o755);
  delete process.env.FAKE_DSH_MODE;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (originalMode === undefined) delete process.env.FAKE_DSH_MODE;
  else process.env.FAKE_DSH_MODE = originalMode;
});

describe("official DeepSeek Harness PM workflow", () => {
  test("drafts a story non-interactively and parses the returned JSON", async () => {
    const result = await runAgent(
      new DeepSeekHarness(),
      cli,
      "Draft a story for a deterministic greeting",
      {
        workingDir: join(root, "repo"),
        silent: true,
      },
    );

    expect(result.exitCode).toBe(0);
    const story = parseAgentJson<{ summary: string; description: string }>(result.stdout);
    expect(story.summary).toBe("Add a deterministic greeting");
    expect(story.description).toContain("## Acceptance Criteria");
  });

  test("surfaces credential failures from the story run", async () => {
    process.env.FAKE_DSH_MODE = "missing-credential";
    const result = await runAgent(new DeepSeekHarness(), cli, "Draft a story", {
      workingDir: join(root, "repo"),
      silent: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("MISSING_CREDENTIAL");
  });
});
