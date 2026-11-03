/**
 * End-to-end coverage for the nono sandbox provider.
 *
 * These tests exercise the real boundary: the built CLI runs a deterministic
 * shell agent wrapped by nono, and the agent reports which paths it could
 * write and read. They complement the agent-harness unit tests, which only
 * inspect the generated argv.
 *
 * The suite skips when nono is not installed, so `bun run test` behaves the
 * same on a laptop with nono and in CI without it.
 */

import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { cliPath } from "../../helpers/fixture-workspace";
import { command } from "../../helpers/process";
import {
  createSandboxHome,
  nonoPath,
  pathWithoutNono,
  runtimeBinDir,
  SandboxWorkspace,
  sandboxEnvironment,
} from "../../helpers/sandbox";

const nono = nonoPath();
const skip = !existsSync(cliPath) || nono === undefined;

/** Write a stub harness CLI that accepts `--version` and any probe flags. */
function stubHarness(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho "stub"\n');
  chmodSync(path, 0o700);
}

test.skipIf(skip)(
  "sandbox doctor reports nono as available and what the next run does",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "devintern-e2e-sandbox-doctor-"));
    const home = createSandboxHome();
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    stubHarness(bin, "claude");
    stubHarness(bin, "goose");
    const baseEnv = sandboxEnvironment(root, home);
    const env = {
      ...baseEnv,
      PATH: [bin, baseEnv.PATH].join(delimiter),
    };
    try {
      const explicit = await command([process.execPath, cliPath, "sandbox"], root, env);
      const explicitText = `${explicit.stdout}\n${explicit.stderr}`;
      expect(explicit.exitCode).toBe(0);
      expect(explicitText).toContain("Configured: AGENT_SANDBOX=nono");
      expect(explicitText).toContain("Next run:   agent wrapped with nono (kernel sandbox)");
      expect(explicitText).toContain("✅ available");
      expect(explicitText).toContain("Harness CLI preflight (nono)");
      expect(explicitText).toContain("claude");
      expect(explicitText).not.toContain("FAIL —");

      // `auto` must pick nono for a harness without a built-in sandbox
      // (native only covers claude-code and codex).
      const automatic = await command([process.execPath, cliPath, "sandbox"], root, {
        ...env,
        AGENT_SANDBOX: "auto",
        AGENT_HARNESS: "goose",
      });
      const automaticText = `${automatic.stdout}\n${automatic.stderr}`;
      expect(automatic.exitCode).toBe(0);
      expect(automaticText).toContain("auto picks nono");
      expect(automaticText).toContain("AGENT_SANDBOX=auto would pick: nono");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(skip)(
  "a nono-wrapped agent writes inside the granted paths and cannot escape into HOME",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    try {
      const result = await run.run();
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("🔒 Agent sandbox: nono (kernel sandbox)");

      const checks = run.checks();
      expect(checks["nono-marker"]?.ok).toBe(true);
      expect(checks["working-dir-write"]?.ok).toBe(true);
      expect(checks["temp-write"]?.ok).toBe(true);
      expect(checks["repo-edit"]?.ok).toBe(true);
      // The v1 policy keeps reads open but confines writes.
      expect(checks["home-read"]?.ok).toBe(true);
      expect(checks["home-write"]?.ok).toBe(false);
      expect(existsSync(join(run.home, "sandbox-escape"))).toBe(false);

      expect(await run.git("branch", "--show-current")).toBe(run.head);
      expect(await run.git("diff", "--name-only", `${run.base}...HEAD`)).toBe("src/greeting.ts");
      expect(await run.git("show", "HEAD:src/greeting.ts")).toBe(
        'export const greeting = "Hello, world!";',
      );
      expect(await run.git("status", "--porcelain")).toBe("");
      expect(await run.remoteSha(run.head)).toBe(await run.git("rev-parse", "HEAD"));
    } finally {
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(!existsSync(cliPath))(
  "an explicitly requested nono provider fails closed when nono is unavailable",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    try {
      const result = await run.run({
        PATH: [runtimeBinDir(), pathWithoutNono()].join(delimiter),
      });
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).not.toBe(0);
      expect(text).toContain('Sandbox provider "nono" is not usable on this machine');
      // Nothing ran: no probe report, no commit.
      expect(Object.keys(run.checks())).toHaveLength(0);
      expect(await run.git("rev-list", "--count", `${run.base}..HEAD`)).toBe("0");
    } finally {
      run.dispose();
    }
  },
  90_000,
);

test.skipIf(skip)(
  "an enclosing nono sandbox is inherited instead of nested",
  async () => {
    const run = await new SandboxWorkspace().prepare();
    const marker = join(run.root, "nono-cap.json");
    writeFileSync(marker, "{}");
    try {
      const result = await run.run({ NONO_CAP_FILE: marker });
      const text = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode).toBe(0);
      expect(text).toContain("Already running inside the nono sandbox");

      // HOME is writable because no second sandbox was applied, proving the
      // run inherited the enclosing confinement rather than stacking nono.
      const checks = run.checks();
      expect(checks["home-write"]?.ok).toBe(true);
      expect(checks["repo-edit"]?.ok).toBe(true);
      expect(await run.git("branch", "--show-current")).toBe(run.head);
    } finally {
      run.dispose();
    }
  },
  90_000,
);
