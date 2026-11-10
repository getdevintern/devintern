import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

/**
 * Regression guard for the inert-guard-chain bug: the env pins in
 * tests/run-tests.ts (SENTRY_DISABLED, WEBHOOK_QUEUE_DB, …) make the guard
 * *tests* green even when no guard preload ever loads. This test asserts a
 * behavior that ONLY guard-git-state.ts installs (`process.chdir` replaced
 * with a throwing stub), so dropping the runner's GUARD_PRELOADS flags or the
 * guard itself fails loudly instead of silently restoring the unsafe state.
 *
 * The guard also marks the stub with `__original` (tests/setup/
 * guard-git-state.ts:89); checking it first means the throw probe below only
 * runs once we know the stub is installed.
 */

interface GuardedChdir {
  __original?: typeof process.chdir;
}

const guardedChdir = process.chdir as typeof process.chdir & GuardedChdir;

describe("test git-state guard", () => {
  test("guard-git-state preload replaced process.chdir", () => {
    // Only the preload sets __original. If tests/run-tests.ts stops passing
    // GUARD_PRELOADS (or bunfig.toml drops this guard), this is undefined.
    expect(guardedChdir.__original).toBeTypeOf("function");
  });

  test("process.chdir throws instead of moving the process cwd", () => {
    // The stub throws before touching the cwd, so this cannot leak state. The
    // finally block only matters if the guard regressed and chdir succeeded:
    // restore the original cwd so the failing assertion cannot cascade into
    // unrelated tests in this process.
    const cwd = process.cwd();
    try {
      expect(() => process.chdir(tmpdir())).toThrow(/forbidden in tests/);
    } finally {
      if (process.cwd() !== cwd) process.chdir(cwd);
    }
  });
});
