import { describe, expect, test, mock } from "bun:test";
import {
  extractHarnessFlags,
  parseArgs,
  parseEffortValue,
  validateHarnessName,
} from "./parse-args";

/**
 * parseArgs() and validateHarnessName() exit the process on error. To test
 * these paths in-process we stub `process.exit` and capture the error printed
 * via a console.error spy.
 */
function withExitAndErrorSpies<T>(
  run: (exitSpy: ReturnType<typeof mock>, errSpy: ReturnType<typeof mock>) => T,
): T {
  const originalExit = process.exit;
  const originalError = console.error;
  const exitSpy = mock((_code?: number) => {
    throw new Error("__process_exit__");
  });
  const errSpy = mock((_msg?: unknown) => {});
  (process as unknown as { exit: typeof process.exit }).exit =
    exitSpy as unknown as typeof process.exit;
  console.error = errSpy as unknown as typeof console.error;
  try {
    return run(exitSpy, errSpy);
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = originalExit;
    console.error = originalError;
  }
}

describe("parseArgs", () => {
  describe("--harness flag", () => {
    test("accepts --harness <name> without erroring (value extracted by extractHarnessFlags)", () => {
      const result = parseArgs(["--prompt", "Add login", "--harness", "opencode"]);
      expect(result).not.toBeNull();
      expect(result).not.toBe("init");
      if (result && typeof result === "object" && "source" in result) {
        expect(result.source).toEqual({ type: "prompt", content: "Add login" });
      } else {
        throw new Error("expected CLIArgs result");
      }
    });

    test("exits when --harness is the last argument (missing value)", () => {
      withExitAndErrorSpies((exitSpy, errSpy) => {
        expect(() => parseArgs(["--prompt", "Add login", "--harness"])).toThrow("__process_exit__");
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
        expect(errMessage).toContain("--harness requires a value");
      });
    });

    test("does NOT validate the harness name in parseArgs (delegates to main())", () => {
      const result = parseArgs(["--prompt", "Add login", "--harness", "unknown-harness"]);
      expect(result).not.toBeNull();
    });
  });

  describe("--effort flag", () => {
    test("accepts each documented effort value", () => {
      for (const level of ["low", "medium", "high"] as const) {
        const result = parseArgs(["--prompt", "Add login", "--effort", level]);
        expect(
          result && typeof result === "object" && "effort" in result ? result.effort : null,
        ).toBe(level);
      }
    });

    test("trims surrounding whitespace in the value", () => {
      const result = parseArgs(["--prompt", "Add login", "--effort", " high "]);
      expect(
        result && typeof result === "object" && "effort" in result ? result.effort : null,
      ).toBe("high");
    });

    test("defaults to undefined when --effort is absent", () => {
      const result = parseArgs(["--prompt", "Add login"]);
      expect(
        result && typeof result === "object" && "effort" in result ? result.effort : null,
      ).toBeUndefined();
    });

    test("exits with a clear error for an invalid effort value", () => {
      withExitAndErrorSpies((exitSpy, errSpy) => {
        expect(() => parseArgs(["--prompt", "Add login", "--effort", "ultra"])).toThrow(
          "__process_exit__",
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
        expect(errMessage).toContain('Invalid agent effort "ultra"');
        expect(errMessage).toContain("Valid values: low, medium, high");
      });
    });

    test("exits when --effort is the last argument (missing value)", () => {
      withExitAndErrorSpies((exitSpy, errSpy) => {
        expect(() => parseArgs(["--prompt", "Add login", "--effort"])).toThrow("__process_exit__");
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
        expect(errMessage).toContain("--effort requires a value");
      });
    });
  });

  describe("interactive / command sentinels", () => {
    test("returns null for --interactive", () => {
      expect(parseArgs(["--interactive"])).toBeNull();
    });

    test("returns null for --interactive combined with --harness", () => {
      expect(parseArgs(["--interactive", "--harness", "opencode"])).toBeNull();
    });

    test('returns "init" for the init command', () => {
      expect(parseArgs(["init"])).toBe("init");
      expect(parseArgs(["--init"])).toBe("init");
    });
  });

  describe("required arguments", () => {
    test("exits with code 0 and shows help when no args are provided", () => {
      withExitAndErrorSpies((exitSpy) => {
        expect(() => parseArgs([])).toThrow("__process_exit__");
        expect(exitSpy).toHaveBeenCalledWith(0);
      });
    });

    test("exits with code 1 when a non-interactive run omits --figma/--log/--prompt", () => {
      withExitAndErrorSpies((exitSpy, errSpy) => {
        expect(() => parseArgs(["--harness", "opencode"])).toThrow("__process_exit__");
        expect(exitSpy).toHaveBeenCalledWith(1);
        const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
        expect(errMessage).toContain("Source is required");
      });
    });
  });
});

describe("parseEffortValue", () => {
  test("returns the validated value at the given index", () => {
    expect(parseEffortValue(["--effort", "high"], 0)).toBe("high");
    expect(parseEffortValue(["--prompt", "x", "--effort", " low "], 2)).toBe("low");
  });

  test("exits when --effort is the last argument (missing value)", () => {
    withExitAndErrorSpies((exitSpy, errSpy) => {
      expect(() => parseEffortValue(["--effort"], 0)).toThrow("__process_exit__");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
      expect(errMessage).toContain("--effort requires a value");
    });
  });

  test("exits for an invalid effort value", () => {
    withExitAndErrorSpies((exitSpy, errSpy) => {
      expect(() => parseEffortValue(["--effort", "ultra"], 0)).toThrow("__process_exit__");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
      expect(errMessage).toContain('Invalid agent effort "ultra"');
    });
  });
});

describe("extractHarnessFlags", () => {
  test("returns the harness name when --harness is present", () => {
    expect(extractHarnessFlags(["--prompt", "x", "--harness", "codex"])).toEqual({
      harness: "codex",
    });
  });

  test("returns empty object when --harness is absent", () => {
    expect(extractHarnessFlags(["--prompt", "x"])).toEqual({});
  });

  test("exits when --harness is missing its value", () => {
    withExitAndErrorSpies((exitSpy, errSpy) => {
      expect(() => extractHarnessFlags(["--interactive", "--harness"])).toThrow("__process_exit__");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
      expect(errMessage).toContain("--harness requires a value");
    });
  });
});

describe("validateHarnessName", () => {
  test("no-ops for undefined", () => {
    expect(() => validateHarnessName(undefined)).not.toThrow();
  });

  test("no-ops for a known harness", () => {
    expect(() => validateHarnessName("opencode")).not.toThrow();
  });

  test("exits for an unknown harness", () => {
    withExitAndErrorSpies((exitSpy, errSpy) => {
      expect(() => validateHarnessName("not-a-real-harness")).toThrow("__process_exit__");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errMessage = String(errSpy.mock.calls[0]?.[0] ?? "");
      expect(errMessage).toContain("Unknown agent harness");
      expect(errMessage).toContain("not-a-real-harness");
    });
  });
});
