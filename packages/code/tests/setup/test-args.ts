import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * `bun test` flags that take their value as the next argument (`-t acquire`).
 * The value after one of these is never treated as a path. The `--flag=value`
 * form needs no entry: it is a single argument starting with `-`.
 */
const FLAGS_WITH_SEPARATE_VALUE = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--max-concurrency",
  "-r",
  "--preload",
  "--require",
  "--import",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
  "--path-ignore-patterns",
  "-c",
  "--config",
  "--cwd",
  "--env-file",
  "--tsconfig-override",
  "-d",
  "--define",
  "-l",
  "--loader",
  "--conditions",
]);

function isInside(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ancestors(dir: string): string[] {
  const dirs = [dir];
  let current = dir;
  while (dirname(current) !== current) {
    current = dirname(current);
    dirs.push(current);
  }
  return dirs;
}

/**
 * Rewrite path arguments for the inner `bun test`, which runs with
 * `cwd: tests/`. A non-flag argument that names an existing file or directory
 * inside `testsDir`, resolved against `invokeCwd` or one of its ancestors
 * (`tests/foo.test.ts`, `./tests/foo.test.ts`, or
 * `packages/code/tests/foo.test.ts` from the repo root), becomes a
 * `./`-prefixed path relative to `testsDir`.
 *
 * Left untouched: flags and their values, arguments that already resolve
 * under `testsDir` (`./lock-manager.test.ts`, or an absolute path into
 * `testsDir`, which Bun accepts as is), bare name filters, and paths outside
 * `testsDir` (Bun reports those as before).
 */
export function normalizeTestArgs(
  args: readonly string[],
  invokeCwd: string,
  testsDir: string,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const out: string[] = [];
  let valueExpected = false;
  for (const arg of args) {
    if (valueExpected) {
      valueExpected = false;
      out.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      valueExpected = FLAGS_WITH_SEPARATE_VALUE.has(arg);
      out.push(arg);
      continue;
    }
    out.push(rewritePath(arg, invokeCwd, testsDir, exists));
  }
  return out;
}

function rewritePath(
  arg: string,
  invokeCwd: string,
  testsDir: string,
  exists: (path: string) => boolean,
): string {
  if (arg === "") return arg;
  const underTests = resolve(testsDir, arg);
  if (isInside(testsDir, underTests) && exists(underTests)) return arg;

  const bases = isAbsolute(arg) ? [invokeCwd] : ancestors(invokeCwd);
  for (const base of bases) {
    const candidate = resolve(base, arg);
    if (!isInside(testsDir, candidate) || !exists(candidate)) continue;
    const rel = relative(testsDir, candidate);
    return rel === "" ? "./" : `./${rel.split(sep).join("/")}`;
  }
  return arg;
}
