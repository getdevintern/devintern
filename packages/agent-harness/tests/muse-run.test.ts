import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MuseHarness } from "../src/harnesses/muse.js";
import { runAgentBun } from "../src/runners/bun.js";
import { runAgentNode } from "../src/runners/node.js";

const dir = mkdtempSync(join(tmpdir(), "muse-run-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a fake `muse` executable that prints its argv and then exits with the
 * requested code, optionally emitting Muse's step-limit diagnostic.
 */
function stubMuse(name: string, exitCode: number, diagnostic?: string): string {
  const script = [
    "#!/bin/sh",
    'printf "argv:%s\\n" "$*"',
    diagnostic ? `printf "%s\\n" "${diagnostic}" >&2` : "",
    `exit ${exitCode}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
  const path = join(dir, name);
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe("Muse Code run outcomes", () => {
  const harness = new MuseHarness();

  test("probe reads the installed version for flag gating", () => {
    const path = join(dir, "muse-version");
    writeFileSync(path, '#!/bin/sh\nprintf "muse 1.4.11\\n"\n', { mode: 0o755 });
    chmodSync(path, 0o755);

    expect(harness.probe(path)).toEqual({
      version: "muse 1.4.11",
      major: 1,
      minor: 4,
      patch: 11,
    });
  });

  test("Bun runner returns a completed turn and passes unattended flags", async () => {
    const path = stubMuse("muse-ok", 0);
    const result = await runAgentBun(harness, path, "do the task", {
      silent: true,
      maxTurns: 3,
      skipPermissions: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.maxTurnsReached).toBe(false);
    expect(result.stdout).toContain("--disable-request-user-input");
    expect(result.stdout).toContain("--disable-approval");
    expect(result.stdout).toContain("--sandbox-network unrestricted");
    expect(result.stdout).toContain("--max-model-steps 3");
    expect(result.stdout).toContain("do the task");
  });

  test("step-limit diagnostics are reported as a turn-limit outcome", async () => {
    const path = stubMuse("muse-step-limit", 1, "This turn reached its step limit.");
    const result = await runAgentNode(harness, path, "do the task", {
      silent: true,
      maxTurns: 3,
      skipPermissions: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.maxTurnsReached).toBe(true);
  });

  test("usage errors keep their exit code and are not misread as a turn limit", async () => {
    const path = stubMuse("muse-usage", 2, "error: unexpected argument '--nope' found");
    const result = await runAgentBun(harness, path, "do the task", { silent: true });

    expect(result.exitCode).toBe(2);
    expect(result.maxTurnsReached).toBe(false);
  });
});
