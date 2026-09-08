import { describe, expect, test } from "bun:test";

/**
 * Regression guard for DEVINTERN-7: the Sentry noop pin from
 * bunfig preload (tests/setup/guard-sentry.ts) and the runner
 * (tests/run-tests.ts) must be active, otherwise expected user-input
 * validation failures exercised by the suite (e.g. the markdown client's
 * "File is empty" / "File not found" error paths) are shipped to the
 * baked-in production Sentry DSN from test/CI processes.
 */
describe("test Sentry pin", () => {
  test("SENTRY_DISABLED is pinned to 1 in every test process", () => {
    expect(process.env.SENTRY_DISABLED).toBe("1");
  });
});
