import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GUARD_FILES } from "./setup/guard-files.ts";

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

/** Package root, whose bunfig.toml is the source of truth for the guard chain. */
const PACKAGE_ROOT = resolve(__dirname, "..");

/** Absolute path of every guard preload file. */
const EXPECTED_PRELOADS = GUARD_FILES.map((guard) =>
  join(PACKAGE_ROOT, "tests", "setup", guard),
).sort();

const PROBE_TEST = `import { expect, test } from "bun:test";

test("Sentry is disabled in a root-invoked test process", () => {
  expect(process.env.SENTRY_DISABLED).toBe("1");
});
`;

/**
 * Vars `tests/run-tests.ts` injects into the child Bun process, plus the git
 * hook vars `guard-git-state.ts` refuses to run with. A plain shell-launched
 * root run has none of them, so the probes must not inherit them from this
 * test process either.
 */
const PARENT_ONLY_ENV = [
  "SENTRY_DISABLED",
  "GIT_CEILING_DIRECTORIES",
  "WEBHOOK_QUEUE_DB",
  "DEVINTERN_WORKSPACE_DIR",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
] as const;

/** Environment a plain `bun test` started from the repo root would see. */
function rootRunEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of PARENT_ONLY_ENV) delete env[key];
  return env;
}

/** Run a throwaway probe test file from the repo root with `env`. */
async function runRootProbe(
  env: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  // A fixture outside the repo keeps the spawned Bun instance from
  // discovering (and running) this suite recursively.
  const probeDir = mkdtempSync(join(tmpdir(), "sentry-root-guard-"));
  const probePath = join(probeDir, "sentry-pin.test.ts");
  writeFileSync(probePath, PROBE_TEST);

  try {
    const proc = Bun.spawn(["bun", "test", probePath], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [[stdout, stderr], exitCode] = await Promise.all([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
      proc.exited,
    ]);
    return { exitCode, output: stdout + stderr };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

describe("test Sentry pin", () => {
  test("SENTRY_DISABLED is pinned to 1 in every test process", () => {
    expect(process.env.SENTRY_DISABLED).toBe("1");
  });

  test("both bunfig files preload the full guard chain", () => {
    for (const [label, configPath] of [
      ["root", join(REPO_ROOT, "bunfig.toml")],
      ["package", join(PACKAGE_ROOT, "bunfig.toml")],
    ] as const) {
      // Parse the TOML and inspect `test.preload` itself: comments in these
      // files mention every guard by name, so a raw text search would pass even
      // with the preload array emptied.
      const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
        test?: { preload?: unknown };
      };
      const preload = config.test?.preload;
      expect(Array.isArray(preload), `${label} bunfig.toml must define test.preload`).toBe(true);

      const actual = (preload as string[])
        .map((entry) => resolve(dirname(configPath), entry))
        .sort();
      expect(actual, `${label} bunfig.toml must preload exactly the guard chain`).toEqual(
        EXPECTED_PRELOADS,
      );
    }
  });

  test("root-invoked runs inherit the pin from the root bunfig preload", async () => {
    // `bun test` from the repo root discovers the package tests but does not
    // read packages/code/bunfig.toml, so the root config has to preload
    // guard-sentry.ts itself. Build the environment from scratch (minus every
    // pin tests/run-tests.ts injects) so the probe cannot pass on state
    // inherited from this process.
    const env = rootRunEnv();
    // A real root run must provide GIT_CEILING_DIRECTORIES or guard-git-state
    // aborts before guard-sentry loads (see the sibling test); provide it here
    // deliberately so this probe actually reaches the Sentry guard.
    env.GIT_CEILING_DIRECTORIES = resolve(tmpdir());

    const { exitCode, output } = await runRootProbe(env);
    if (exitCode !== 0) {
      throw new Error(
        `root-invoked bun test did not inherit SENTRY_DISABLED=1\n` +
          `exit code: ${exitCode}\noutput:\n${output}`,
      );
    }
    // Guard against a vacuous pass where Bun never ran the probe test.
    expect(output).toContain("1 pass");
  });

  test("a bare root run without GIT_CEILING_DIRECTORIES aborts before the Sentry guard", async () => {
    // Documents the prerequisite the test above relies on: guard-git-state
    // refuses to run when GIT_CEILING_DIRECTORIES is missing, so a plain
    // `bun test` at the repo root never reaches guard-sentry. This keeps that
    // behavior intentional instead of letting it silently regress.
    const { exitCode, output } = await runRootProbe(rootRunEnv());

    expect(exitCode).not.toBe(0);
    expect(output).toContain("GIT_CEILING_DIRECTORIES must include");
    expect(output).not.toContain("1 pass");
  });
});
