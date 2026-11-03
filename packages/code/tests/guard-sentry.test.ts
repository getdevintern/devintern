import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Regression guard for DEVINTERN-7: the Sentry noop pin from
 * bunfig preload (tests/setup/guard-sentry.ts) and the runner
 * (tests/run-tests.ts) must be active, otherwise expected user-input
 * validation failures exercised by the suite (e.g. the markdown client's
 * "File is empty" / "File not found" error paths) are shipped to the
 * baked-in production Sentry DSN from test/CI processes.
 */

/** Repo root, whose bunfig.toml is the one Bun reads for root-invoked runs. */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const PROBE_TEST = `import { expect, test } from "bun:test";

test("Sentry is disabled in a root-invoked test process", () => {
  expect(process.env.SENTRY_DISABLED).toBe("1");
});
`;

describe("test Sentry pin", () => {
  test("SENTRY_DISABLED is pinned to 1 in every test process", () => {
    expect(process.env.SENTRY_DISABLED).toBe("1");
  });

  test("root-invoked runs inherit the pin from the root bunfig preload", async () => {
    // `bun test` from the repo root discovers the package tests but does not
    // read packages/code/bunfig.toml, so the root config has to preload
    // guard-sentry.ts itself. A fixture outside the repo keeps the spawned
    // Bun instance from discovering (and running) this suite recursively.
    const probeDir = mkdtempSync(join(tmpdir(), "sentry-root-guard-"));
    const probePath = join(probeDir, "sentry-pin.test.ts");
    writeFileSync(probePath, PROBE_TEST);
    // Simulate a plain root-invoked run: the guard must come from the root
    // bunfig preload, not from a pin the parent test process inherited.
    const rootEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "SENTRY_DISABLED") rootEnv[key] = value;
    }

    try {
      const proc = Bun.spawn(["bun", "test", probePath], {
        cwd: REPO_ROOT,
        env: rootEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [[stdout, stderr], exitCode] = await Promise.all([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(
          `root-invoked bun test did not inherit SENTRY_DISABLED=1\n` +
            `exit code: ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      // Guard against a vacuous pass where Bun never ran the probe test.
      expect(stdout + stderr).toContain("1 pass");
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
