import { afterEach, describe, expect, test } from "bun:test";

import {
  AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV,
  AUTO_REVIEW_ITERATIONS_ENV,
  DEFAULT_AUTO_REVIEW_ITERATIONS,
  InvalidAutoReviewIterationsError,
  parseAutoReviewIterations,
  resolveAutoReviewIterations,
  resolveAutoReviewIterationsIfEnabled,
} from "../src/lib/auto-review-config";

const ENV_VARS = [AUTO_REVIEW_ITERATIONS_ENV, AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV] as const;
const originals = new Map(ENV_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_VARS) {
    const original = originals.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

function setEnv(name: (typeof ENV_VARS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("DEFAULT_AUTO_REVIEW_ITERATIONS", () => {
  test("is lower than the old 5-round cap", () => {
    expect(DEFAULT_AUTO_REVIEW_ITERATIONS).toBe(2);
  });
});

describe("parseAutoReviewIterations", () => {
  test("accepts whole numbers >= 1", () => {
    expect(parseAutoReviewIterations("1", "test")).toBe(1);
    expect(parseAutoReviewIterations("2", "test")).toBe(2);
    expect(parseAutoReviewIterations(" 5 ", "test")).toBe(5);
  });

  test("rejects non-numeric, fractional, and sub-1 values", () => {
    for (const raw of ["abc", "", "1.5", "2x", "0", "-1", "NaN", "Infinity"]) {
      expect(() => parseAutoReviewIterations(raw, "test")).toThrow(
        InvalidAutoReviewIterationsError,
      );
    }
  });

  test("rejects values beyond the safe integer range", () => {
    expect(() => parseAutoReviewIterations("9007199254740992", "test")).toThrow(
      InvalidAutoReviewIterationsError,
    );
  });

  test("error names the source and explains the constraint", () => {
    expect(() => parseAutoReviewIterations("abc", "--auto-review-iterations")).toThrow(
      /--auto-review-iterations must be a whole number of iterations >= 1 \(got "abc"\)/,
    );
    expect(() => parseAutoReviewIterations("0", "AUTO_REVIEW_ITERATIONS")).toThrow(
      /AUTO_REVIEW_ITERATIONS must be a whole number of iterations >= 1 \(got "0"\)/,
    );
  });
});

describe("resolveAutoReviewIterations", () => {
  test("falls back to the shared default when nothing is set", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, undefined);
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, undefined);
    expect(resolveAutoReviewIterations()).toBe(DEFAULT_AUTO_REVIEW_ITERATIONS);
    expect(resolveAutoReviewIterations(undefined)).toBe(DEFAULT_AUTO_REVIEW_ITERATIONS);
  });

  test("applies the unified env var without the CLI flag", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, "4");
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, undefined);
    expect(resolveAutoReviewIterations()).toBe(4);
  });

  test("explicit CLI arg wins over the env var", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, "4");
    expect(resolveAutoReviewIterations("3")).toBe(3);
  });

  test("treats an empty env value as unset", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, "");
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, undefined);
    expect(resolveAutoReviewIterations()).toBe(DEFAULT_AUTO_REVIEW_ITERATIONS);
  });

  test("uses the deprecated webhook env var as a fallback", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, undefined);
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, "5");
    expect(resolveAutoReviewIterations()).toBe(5);
  });

  test("unified env var wins when both env vars are set", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, "3");
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, "5");
    expect(resolveAutoReviewIterations()).toBe(3);
  });

  test("warns on stderr when the deprecated env var is used", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, undefined);
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, "5");
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      resolveAutoReviewIterations();
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join("")).toContain(
      "WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS is deprecated, use AUTO_REVIEW_ITERATIONS instead",
    );
  });

  test("rejects an invalid CLI arg", () => {
    for (const raw of ["abc", "0", "-1", "1.5"]) {
      expect(() => resolveAutoReviewIterations(raw)).toThrow(InvalidAutoReviewIterationsError);
    }
  });

  test("rejects an invalid unified env var", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, "zero");
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, undefined);
    expect(() => resolveAutoReviewIterations()).toThrow(
      /AUTO_REVIEW_ITERATIONS must be a whole number of iterations >= 1 \(got "zero"\)/,
    );
  });

  test("rejects an invalid deprecated env var", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, undefined);
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, "0");
    expect(() => resolveAutoReviewIterations()).toThrow(
      /WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS must be a whole number of iterations >= 1 \(got "0"\)/,
    );
  });

  test("value 1 resolves to a single review pass", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, undefined);
    setEnv(AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV, undefined);
    expect(resolveAutoReviewIterations("1")).toBe(1);
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, "1");
    expect(resolveAutoReviewIterations()).toBe(1);
  });

  test("reads env vars from the provided environment object, not process.env", () => {
    setEnv(AUTO_REVIEW_ITERATIONS_ENV, "9");
    expect(resolveAutoReviewIterations(undefined, { [AUTO_REVIEW_ITERATIONS_ENV]: "4" })).toBe(4);
    expect(resolveAutoReviewIterations(undefined, {})).toBe(DEFAULT_AUTO_REVIEW_ITERATIONS);
  });
});

describe("resolveAutoReviewIterationsIfEnabled", () => {
  // Pure env fixtures: no process.env mutation, so these tests exercise the
  // webhook server's resolution without spawning a server.
  const autoReviewOn = { WEBHOOK_AUTO_REVIEW: "true" } as Record<string, string | undefined>;

  function captureStderr(fn: () => void): string {
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      fn();
    } finally {
      process.stderr.write = originalWrite;
    }
    return writes.join("");
  }

  test("applies the unified env var when auto-review is enabled", () => {
    const env = { ...autoReviewOn, [AUTO_REVIEW_ITERATIONS_ENV]: "4" };
    expect(resolveAutoReviewIterationsIfEnabled(undefined, true, env)).toBe(4);
  });

  test("unified env var wins over the deprecated fallback when auto-review is enabled", () => {
    const env = {
      ...autoReviewOn,
      [AUTO_REVIEW_ITERATIONS_ENV]: "3",
      [AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV]: "5",
    };
    expect(resolveAutoReviewIterationsIfEnabled(undefined, true, env)).toBe(3);
  });

  test("honors the deprecated webhook env var with a warning when auto-review is enabled", () => {
    const env = {
      ...autoReviewOn,
      [AUTO_REVIEW_ITERATIONS_ENV]: undefined,
      [AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV]: "5",
    };
    let output = "";
    let resolved: number | undefined;
    expect(() => {
      output = captureStderr(() => {
        resolved = resolveAutoReviewIterationsIfEnabled(undefined, true, env);
      });
    }).not.toThrow();
    expect(resolved).toBe(5);
    expect(output).toContain(
      "WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS is deprecated, use AUTO_REVIEW_ITERATIONS instead",
    );
  });

  test("falls back to the shared default when auto-review is enabled and no env var is set", () => {
    const env = { ...autoReviewOn, [AUTO_REVIEW_ITERATIONS_ENV]: "" };
    expect(resolveAutoReviewIterationsIfEnabled(undefined, true, env)).toBe(
      DEFAULT_AUTO_REVIEW_ITERATIONS,
    );
  });

  test("aborts startup with a clear error when an invalid env var meets enabled auto-review", () => {
    const env = { ...autoReviewOn, [AUTO_REVIEW_ITERATIONS_ENV]: "abc" };
    expect(() => resolveAutoReviewIterationsIfEnabled(undefined, true, env)).toThrow(
      /AUTO_REVIEW_ITERATIONS must be a whole number of iterations >= 1 \(got "abc"\)/,
    );
    const deprecatedEnv = {
      [AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV]: "0",
    } as Record<string, string | undefined>;
    expect(() => resolveAutoReviewIterationsIfEnabled(undefined, true, deprecatedEnv)).toThrow(
      /WEBHOOK_AUTO_REVIEW_MAX_ITERATIONS must be a whole number of iterations >= 1 \(got "0"\)/,
    );
  });

  test("ignores env vars entirely when auto-review is off and no explicit value is given", () => {
    // Mirrors the CLI: the cap is unused, so even an invalid value must not
    // block startup (and a valid one is simply not consulted).
    const invalid = { [AUTO_REVIEW_ITERATIONS_ENV]: "abc" } as Record<string, string | undefined>;
    expect(resolveAutoReviewIterationsIfEnabled(undefined, false, invalid)).toBe(
      DEFAULT_AUTO_REVIEW_ITERATIONS,
    );
    const valid = { [AUTO_REVIEW_ITERATIONS_ENV]: "4" } as Record<string, string | undefined>;
    expect(resolveAutoReviewIterationsIfEnabled(undefined, false, valid)).toBe(
      DEFAULT_AUTO_REVIEW_ITERATIONS,
    );
    const deprecatedOnly = {
      [AUTO_REVIEW_ITERATIONS_DEPRECATED_ENV]: "5",
    } as Record<string, string | undefined>;
    const output = captureStderr(() => {
      expect(resolveAutoReviewIterationsIfEnabled(undefined, false, deprecatedOnly)).toBe(
        DEFAULT_AUTO_REVIEW_ITERATIONS,
      );
    });
    expect(output).toBe("");
  });

  test("bridges a numeric explicit config value via String() and validates it", () => {
    expect(resolveAutoReviewIterationsIfEnabled(4, false, {})).toBe(4);
    expect(() => resolveAutoReviewIterationsIfEnabled(0, false, {})).toThrow(
      InvalidAutoReviewIterationsError,
    );
  });

  test("explicit value wins over the env var, even with auto-review off", () => {
    const env = { ...autoReviewOn, [AUTO_REVIEW_ITERATIONS_ENV]: "4" };
    expect(resolveAutoReviewIterationsIfEnabled("3", true, env)).toBe(3);
    expect(resolveAutoReviewIterationsIfEnabled(3, false, env)).toBe(3);
    expect(() => resolveAutoReviewIterationsIfEnabled("abc", false, env)).toThrow(
      InvalidAutoReviewIterationsError,
    );
  });
});
