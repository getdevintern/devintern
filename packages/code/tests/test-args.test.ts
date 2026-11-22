import { describe, expect, test } from "bun:test";

import { normalizeTestArgs } from "./setup/test-args";

const PKG = "/repo/packages/code";
const TESTS = `${PKG}/tests`;
const FILES = new Set([
  "/repo",
  "/repo/packages",
  PKG,
  `${PKG}/src`,
  `${PKG}/src/index.ts`,
  TESTS,
  `${TESTS}/setup`,
  `${TESTS}/worker-doctor.test.ts`,
  `${TESTS}/lock-manager.test.ts`,
]);
const exists = (path: string) => FILES.has(path);
const run = (args: string[], cwd = PKG) => normalizeTestArgs(args, cwd, TESTS, exists);

describe("normalizeTestArgs", () => {
  test("rewrites package-relative and ./tests/-prefixed paths into tests/", () => {
    expect(run(["tests/worker-doctor.test.ts"])).toEqual(["./worker-doctor.test.ts"]);
    expect(run(["./tests/worker-doctor.test.ts"])).toEqual(["./worker-doctor.test.ts"]);
    expect(run(["tests/setup"])).toEqual(["./setup"]);
    expect(run(["tests"])).toEqual(["./"]);
  });

  test("resolves repo-root-relative paths through ancestors of the invoking cwd", () => {
    expect(run(["packages/code/tests/worker-doctor.test.ts"])).toEqual(["./worker-doctor.test.ts"]);
    expect(run(["packages/code/tests/worker-doctor.test.ts"], "/repo")).toEqual([
      "./worker-doctor.test.ts",
    ]);
  });

  test("keeps paths that already resolve under tests/, including absolute ones", () => {
    expect(run([`${TESTS}/worker-doctor.test.ts`])).toEqual([`${TESTS}/worker-doctor.test.ts`]);
    expect(run(["./lock-manager.test.ts"])).toEqual(["./lock-manager.test.ts"]);
    expect(run(["setup"])).toEqual(["setup"]);
  });

  test("leaves name filters, missing paths, and paths outside tests/ alone", () => {
    expect(run(["worker-doctor"])).toEqual(["worker-doctor"]);
    expect(run(["tests/missing.test.ts"])).toEqual(["tests/missing.test.ts"]);
    expect(run(["src/index.ts"])).toEqual(["src/index.ts"]);
    expect(run(["../code/src"])).toEqual(["../code/src"]);
  });

  test("never rewrites flags or flag values", () => {
    expect(run(["-t", "tests", "worker-doctor"])).toEqual(["-t", "tests", "worker-doctor"]);
    expect(run(["--test-name-pattern", "tests/worker-doctor.test.ts"])).toEqual([
      "--test-name-pattern",
      "tests/worker-doctor.test.ts",
    ]);
    expect(run(["--timeout=5000", "--bail", "tests/worker-doctor.test.ts"])).toEqual([
      "--timeout=5000",
      "--bail",
      "./worker-doctor.test.ts",
    ]);
  });
});
