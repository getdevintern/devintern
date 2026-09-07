import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { LicenseCheckError, requireLicense } from "../src/index";

/**
 * `requireLicense` is an exported library function: it must never terminate
 * the host process. It used to call `process.exit(1)` on an invalid result,
 * so any in-process consumer (audit fuzzing of package exports, embedded
 * tooling) died with `fuzz-intercepted-process-exit` when handed a fuzzed
 * `{ valid: false }` result. The failure path now throws a typed error that
 * CLI entry points convert into their exit code instead.
 */
describe("requireLicense failure path", () => {
  const originalExit = process.exit;

  afterEach(() => {
    (process as unknown as { exit: typeof process.exit }).exit = originalExit;
    mock.restore();
  });

  /** Stub process.exit into a recorder so a stray exit fails the test, not the runner. */
  function stubExit(): Array<number | undefined> {
    const exitCalls: Array<number | undefined> = [];
    (process as unknown as { exit: typeof process.exit }).exit = ((code?: number) => {
      exitCalls.push(code);
    }) as typeof process.exit;
    return exitCalls;
  }

  test("throws LicenseCheckError instead of exiting on an invalid result", () => {
    const exitCalls = stubExit();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    let thrown: unknown;
    try {
      requireLicense({ valid: false, source: "none", message: "No LICENSE_KEY is set." });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LicenseCheckError);
    expect((thrown as Error).name).toBe("LicenseCheckError");
    expect((thrown as Error).message).toBe("No LICENSE_KEY is set.");
    expect(exitCalls).toEqual([]);
    // Operator-facing failure output is unchanged.
    expect(errorSpy).toHaveBeenCalledWith("\n❌ License check failed");
    expect(errorSpy).toHaveBeenCalledWith("   No LICENSE_KEY is set.\n");
  });

  test("throws for fuzz-shaped results with an empty message", () => {
    const exitCalls = stubExit();
    spyOn(console, "error").mockImplementation(() => {});

    let thrown: unknown;
    try {
      requireLicense({ valid: false, source: "none", message: "" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LicenseCheckError);
    expect(exitCalls).toEqual([]);
  });

  test("does not throw for a valid license-key result", () => {
    const exitCalls = stubExit();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    expect(() =>
      requireLicense({
        valid: true,
        source: "license-key",
        message: "License valid.",
      }),
    ).not.toThrow();
    expect(exitCalls).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith("✅ License valid.\n");
  });

  test("does not throw for a grace result", () => {
    const exitCalls = stubExit();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      requireLicense({
        valid: true,
        source: "grace",
        message: "License server unreachable; honoring cached entitlement.",
      }),
    ).not.toThrow();
    expect(exitCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  License server unreachable; honoring cached entitlement.\n",
    );
  });
});
