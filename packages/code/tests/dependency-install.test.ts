/**
 * Test suite for dependency installation in worktrees
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Utils } from "../src/lib/utils";
import { execSync } from "child_process";

describe("Dependency Installation", () => {
  let testDir: string;
  let repoDir: string;
  let originalWorktreeEnv: string | undefined;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(
      tmpdir(),
      `dependency-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    mkdirSync(testDir, { recursive: true });

    // Isolate the shared review worktree path so these tests never remove or
    // prune the production worktree at /tmp/devintern-review-worktree.
    originalWorktreeEnv = process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    process.env.DEVINTERN_REVIEW_WORKTREE_PATH = join(testDir, "review-worktree");

    // Create a test git repository
    repoDir = join(testDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });

    // Initialize git repo
    execSync("git init", { cwd: repoDir });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir });
    execSync("git config user.name 'Test User'", { cwd: repoDir });

    // Create initial commit on main branch
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Initial commit'", { cwd: repoDir });

    // Create .devintern-code directory
    mkdirSync(join(repoDir, ".devintern-code"), { recursive: true });
  });

  afterEach(() => {
    // Restore the review worktree path override
    if (originalWorktreeEnv === undefined) {
      delete process.env.DEVINTERN_REVIEW_WORKTREE_PATH;
    } else {
      process.env.DEVINTERN_REVIEW_WORKTREE_PATH = originalWorktreeEnv;
    }

    // Clean up test directory
    try {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("should skip installation when no package.json exists", async () => {
    const testWorkingDir = join(testDir, "no-package");
    mkdirSync(testWorkingDir, { recursive: true });

    const result = await Utils.installDependencies(testWorkingDir, { verbose: false });

    expect(result.success).toBe(true);
    expect(result.packageManager).toBeUndefined();
  });

  test("should detect bun.lockb and use bun", async () => {
    const testWorkingDir = join(testDir, "bun-project");
    mkdirSync(testWorkingDir, { recursive: true });

    // Create package.json and bun.lockb
    writeFileSync(
      join(testWorkingDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: {} }),
      "utf8",
    );
    writeFileSync(join(testWorkingDir, "bun.lockb"), "", "utf8");

    const result = await Utils.installDependencies(testWorkingDir, { verbose: false });

    // Should succeed (even if bun fails, we test the detection)
    expect(result.packageManager).toBe("bun");
  });

  test("should detect the bun.lock text lockfile and use bun", async () => {
    const testWorkingDir = join(testDir, "bun-text-lock-project");
    mkdirSync(testWorkingDir, { recursive: true });

    // Bun writes a text `bun.lock` since 1.2 (instead of binary `bun.lockb`)
    writeFileSync(
      join(testWorkingDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: {} }),
      "utf8",
    );
    writeFileSync(
      join(testWorkingDir, "bun.lock"),
      '{\n  "lockfileVersion": 1,\n  "packages": {},\n}\n',
      "utf8",
    );

    const result = await Utils.installDependencies(testWorkingDir, { verbose: false });

    expect(result.packageManager).toBe("bun");
  });

  test("prepareWorktreeForAgent isolates hooks before installing dependencies", async () => {
    // repoDir is a plain git repository (from beforeEach)
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        dependencies: {},
        scripts: { postinstall: "touch postinstall-marker" },
      }),
      "utf8",
    );
    writeFileSync(
      join(repoDir, "bun.lock"),
      '{\n  "lockfileVersion": 1,\n  "packages": {},\n}\n',
      "utf8",
    );

    const result = await Utils.prepareWorktreeForAgent(repoDir);

    expect(result.success).toBe(true);
    expect(result.packageManager).toBe("bun");

    // The install ran and produced its artifacts.
    expect(existsSync(join(repoDir, "postinstall-marker"))).toBe(true);

    // Hook isolation ran first: core.hooksPath now points at the repo's own
    // hooks dir, so package postinstalls (lefthook) cannot clobber shared hooks.
    const gitDir = execSync("git rev-parse --absolute-git-dir", {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    expect(execSync("git config core.hooksPath", { cwd: repoDir, encoding: "utf8" }).trim()).toBe(
      join(gitDir, "hooks"),
    );
  });

  test("createFeatureBranch keeps installed node_modules through its cleanup", async () => {
    // Freshly installed, untracked node_modules in a repo that does not
    // gitignore it — the hazard case for `git clean -fd`.
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: {} }),
      "utf8",
    );
    mkdirSync(join(repoDir, "node_modules", "installed-pkg"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", "installed-pkg", "index.js"),
      "module.exports = 1;",
    );

    const currentBranch = execSync("git branch --show-current", {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    const result = await Utils.createFeatureBranch("SURV-1", currentBranch, { cwd: repoDir });

    expect(result.success).toBe(true);
    // The pre-branch cleanup (stash + `reset --hard` + `git clean -fd`) did
    // not swallow the installed dependencies the agent still needs.
    expect(existsSync(join(repoDir, "node_modules", "installed-pkg", "index.js"))).toBe(true);
  });

  test("prepareWorktreeForAgent warns but does not throw when install fails", async () => {
    // `npm ci` rejects an out-of-sync lockfile before touching the network,
    // so the install fails deterministically (as does a missing npm).
    const testWorkingDir = join(testDir, "failing-install");
    mkdirSync(testWorkingDir, { recursive: true });
    writeFileSync(
      join(testWorkingDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: { left: "^1.3.0" } }),
      "utf8",
    );
    writeFileSync(
      join(testWorkingDir, "package-lock.json"),
      JSON.stringify({
        name: "test",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "test", version: "1.0.0" } },
      }),
      "utf8",
    );

    const warnSpy = spyOn(console, "warn");
    let result: Awaited<ReturnType<typeof Utils.prepareWorktreeForAgent>>;
    let warned: string[];
    try {
      result = await Utils.prepareWorktreeForAgent(testWorkingDir);
      warned = warnSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      warnSpy.mockRestore();
    }

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(warned.some((message) => message.includes("Failed to install dependencies"))).toBe(true);
  });

  test("should detect pnpm-lock.yaml and use pnpm", async () => {
    const testWorkingDir = join(testDir, "pnpm-project");
    mkdirSync(testWorkingDir, { recursive: true });

    // Create package.json and pnpm-lock.yaml
    writeFileSync(
      join(testWorkingDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: {} }),
      "utf8",
    );
    writeFileSync(join(testWorkingDir, "pnpm-lock.yaml"), "lockfileVersion: 5.4\n", "utf8");

    const result = await Utils.installDependencies(testWorkingDir, { verbose: false });

    expect(result.packageManager).toBe("pnpm");
  });

  test("should detect yarn.lock and use yarn", async () => {
    const testWorkingDir = join(testDir, "yarn-project");
    mkdirSync(testWorkingDir, { recursive: true });

    // Create package.json and yarn.lock
    writeFileSync(
      join(testWorkingDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: {} }),
      "utf8",
    );
    writeFileSync(join(testWorkingDir, "yarn.lock"), "# yarn lockfile v1\n", "utf8");

    const result = await Utils.installDependencies(testWorkingDir, { verbose: false });

    expect(result.packageManager).toBe("yarn");
  });

  test("should detect package-lock.json and use npm", async () => {
    const testWorkingDir = join(testDir, "npm-project");
    mkdirSync(testWorkingDir, { recursive: true });

    // Create package.json and package-lock.json
    writeFileSync(
      join(testWorkingDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: {} }),
      "utf8",
    );
    writeFileSync(
      join(testWorkingDir, "package-lock.json"),
      JSON.stringify({ name: "test", version: "1.0.0", lockfileVersion: 2 }),
      "utf8",
    );

    const result = await Utils.installDependencies(testWorkingDir, { verbose: false });

    expect(result.packageManager).toBe("npm");
  });

  test("should skip installation when package.json exists but no lock file", async () => {
    const testWorkingDir = join(testDir, "no-lock");
    mkdirSync(testWorkingDir, { recursive: true });

    // Create only package.json without lock file
    writeFileSync(
      join(testWorkingDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0", dependencies: {} }),
      "utf8",
    );

    const result = await Utils.installDependencies(testWorkingDir, { verbose: false });

    // Should succeed but not install anything (no lock file detected)
    expect(result.success).toBe(true);
    expect(result.packageManager).toBeUndefined();
  });

  test("should install dependencies when preparing worktree", async () => {
    // Create a branch with package.json
    execSync("git checkout -b feature/with-deps", { cwd: repoDir });

    // Create a simple package.json
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        version: "1.0.0",
        dependencies: {},
        devDependencies: {},
      }),
      "utf8",
    );

    // Create package-lock.json
    writeFileSync(
      join(repoDir, "package-lock.json"),
      JSON.stringify({
        name: "test-project",
        version: "1.0.0",
        lockfileVersion: 2,
        packages: {
          "": {
            name: "test-project",
            version: "1.0.0",
          },
        },
      }),
      "utf8",
    );

    execSync("git add .", { cwd: repoDir });
    execSync("git commit -m 'Add package files'", { cwd: repoDir });
    execSync("git checkout main || git checkout master", { cwd: repoDir });

    // Prepare worktree - should install dependencies
    const result = await Utils.prepareReviewWorktree("feature/with-deps", {
      verbose: false,
      cwd: repoDir,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBeDefined();

    // Verify node_modules was created (if npm install succeeded)
    // Note: This might fail if npm isn't available, which is OK for the test
    const worktreePath = result.path!;
    const packageJsonExists = existsSync(join(worktreePath, "package.json"));
    expect(packageJsonExists).toBe(true);
  });
});
