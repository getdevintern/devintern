/**
 * Test setup guard — preloaded before every test via `bunfig.toml`.
 *
 * Background: tests in this package exercise git workflows (branch creation,
 * worktrees, pushing). Historically some of them did `process.chdir(tempRepo)`
 * and ran git there. When a test threw before restoring the cwd, the *process*
 * was left sitting inside a throwaway repo. The webhook server runs the same
 * code in-process, so a later real `git push` would execute against that stray
 * repo and publish junk branches (e.g. `tracking-test`) with `Test User`
 * commits to the real remote.
 *
 * The fix moved all tests to thread an explicit `cwd` into the git helpers
 * instead of mutating the process cwd. This guard makes that the *only* option:
 * `process.chdir` throws during tests, so no test (now or in the future) can
 * silently move the process into a scratch repo and leave it there. Tests must
 * pass `cwd` to the Utils git helpers.
 *
 * If a test genuinely needs to run in a different directory, pass that path as
 * `cwd` to the helper / `execSync` call rather than changing the process cwd.
 */

// When the test suite runs from a git hook (lefthook pre-push runs the full
// suite), git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to the hook
// process. Child `git` commands inherit them and ignore their { cwd }, so a
// fixture's `git init` / `git branch -m` executes against the REAL repository
// (this rewrote `master` twice). Deleting the vars from process.env is NOT
// enough: Bun passes the environment captured at process start to child
// processes, ignoring later process.env mutations. The only safe move is to
// refuse to run — lefthook.yml launches the suite via `env -u GIT_DIR ...`
// so hook runs never trip this.
const REPO_TARGETING_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
];
const leaked = REPO_TARGETING_VARS.filter((key) => process.env[key] !== undefined);
if (leaked.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `Refusing to run tests: ${leaked.join(", ")} is set in the environment.\n` +
      "Fixture git commands spawned by tests would inherit it and operate on " +
      "the REAL repository instead of their temp dirs (Bun children get the " +
      "process-start environment, so the guard cannot strip it in-process).\n" +
      "Re-run with the variables removed, e.g.: env -u GIT_DIR -u GIT_WORK_TREE " +
      "-u GIT_INDEX_FILE -u GIT_COMMON_DIR bun test",
  );
  process.exit(1);
}

const originalChdir = process.chdir.bind(process);

process.chdir = ((directory: string) => {
  throw new Error(
    `process.chdir(${JSON.stringify(directory)}) is forbidden in tests.\n` +
      "Changing the process working directory leaks state across tests and can " +
      "make later git operations (including the webhook's real pushes) run in the " +
      "wrong repository. Pass an explicit { cwd } to the git helper / execSync " +
      "instead of calling process.chdir().",
  );
}) as typeof process.chdir;

// Keep a reference to the original on the function so a deliberate, isolated
// use can opt out if ever truly required (none currently does).
(process.chdir as unknown as { __original: typeof process.chdir }).__original = originalChdir;
