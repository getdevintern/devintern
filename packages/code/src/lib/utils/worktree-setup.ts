import { spawn } from "child_process";
import { chmodSync, copyFileSync, existsSync, readdirSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { Utils } from "./registry";

/**
 * Point a linked review worktree's `core.hooksPath` at a private directory
 * (via per-worktree git config) seeded with copies of the shared hooks.
 *
 * A linked worktree shares `.git/hooks` with the user's checkout. Dependency
 * postinstalls that rewrite hooks (lefthook's `lefthook install`) would
 * therefore clobber the user's real hooks with scripts hardcoding this
 * ephemeral worktree's `node_modules` path — breaking every later push once
 * the worktree is removed. Redirecting hooks first confines those rewrites
 * to the private directory, where they stay valid for this run's pushes and
 * vanish together with the worktree.
 *
 * The private directory lives in the worktree's git admin area
 * (`<repo>/.git/worktrees/<name>/hooks`), which keeps it outside the working
 * tree (invisible to `git status`, `git clean`, and `git add -A`) and lets
 * `git worktree remove` clean it up automatically. The per-worktree config
 * lives in the same admin area; `extensions.worktreeConfig` stays enabled in
 * the shared config, which is harmless.
 */
export async function isolateWorktreeHooks(
  worktreePath: string,
  options?: { verbose?: boolean },
): Promise<void> {
  const verbose = options?.verbose ?? false;

  const gitDir = await Utils.executeGitCommand(["rev-parse", "--absolute-git-dir"], {
    cwd: worktreePath,
  });
  if (!gitDir.success || !gitDir.output.trim()) {
    console.warn(`⚠️  Could not locate worktree git dir; hooks stay shared: ${gitDir.error}`);
    return;
  }
  const hooksDir = join(gitDir.output.trim(), "hooks");

  // Existing shared hooks (e.g. plain scripts installed outside a package's
  // postinstall) keep working in the worktree: copy them into the isolated
  // directory. This must run before `core.hooksPath` is set, because
  // `git rev-parse --git-path hooks` resolves through it.
  const sharedHooks = await Utils.executeGitCommand(["rev-parse", "--git-path", "hooks"], {
    cwd: worktreePath,
  });
  if (sharedHooks.success && sharedHooks.output.trim() && existsSync(sharedHooks.output.trim())) {
    const sharedDir = sharedHooks.output.trim();
    try {
      Utils.ensureDirectoryExists(hooksDir);
      for (const entry of readdirSync(sharedDir)) {
        if (entry.endsWith(".sample")) continue;
        const source = join(sharedDir, entry);
        if (!statSync(source).isFile()) continue;
        copyFileSync(source, join(hooksDir, entry));
        chmodSync(join(hooksDir, entry), 0o755);
      }
    } catch (error) {
      console.warn(
        `⚠️  Could not copy shared git hooks into the worktree: ${(error as Error).message}`,
      );
    }
  }

  const enable = await Utils.enableWorktreeConfig(worktreePath);
  if (!enable.success) {
    console.warn(`⚠️  Could not enable per-worktree git config: ${enable.error}`);
    return;
  }
  const setPath = await Utils.executeGitCommand(
    ["config", "--worktree", "core.hooksPath", hooksDir],
    { cwd: worktreePath },
  );
  if (!setPath.success) {
    console.warn(`⚠️  Could not redirect worktree git hooks: ${setPath.error}`);
    return;
  }
  if (verbose) {
    console.log(`   🔒 Git hooks isolated to ${hooksDir}`);
  }
}

/**
 * Enable per-worktree config without making linked worktrees from a bare
 * repository inherit `core.bare=true` from the shared config.
 *
 * Git normally treats a linked worktree created from a bare repository as a
 * work tree. Once `extensions.worktreeConfig` is enabled, however, a shared
 * `core.bare=true` overrides that detection and every linked worktree starts
 * rejecting checkout/reset/merge operations. Move the bare-only value to the
 * main worktree's config before enabling the extension, as required by Git's
 * worktree-config layout.
 *
 * This also repairs repositories where the extension was already enabled in
 * the unsafe layout.
 */
export async function enableWorktreeConfig(
  cwd: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  const commonDirResult = await Utils.executeGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
  });
  if (!commonDirResult.success || !commonDirResult.output.trim()) {
    return commonDirResult;
  }

  const commonDir = isAbsolute(commonDirResult.output.trim())
    ? commonDirResult.output.trim()
    : resolve(cwd, commonDirResult.output.trim());
  const sharedConfig = join(commonDir, "config");
  const mainWorktreeConfig = join(commonDir, "config.worktree");
  const sharedBare = await Utils.executeGitCommand(
    ["config", "--file", sharedConfig, "--get", "core.bare"],
    { cwd },
  );

  if (sharedBare.success && sharedBare.output.trim().toLowerCase() === "true") {
    const preserveBare = await Utils.executeGitCommand(
      ["config", "--file", mainWorktreeConfig, "core.bare", "true"],
      { cwd },
    );
    if (!preserveBare.success) {
      return preserveBare;
    }

    const removeSharedBare = await Utils.executeGitCommand(
      ["config", "--file", sharedConfig, "--unset-all", "core.bare"],
      { cwd },
    );
    if (!removeSharedBare.success) {
      // Another worker may have completed the same idempotent migration
      // after our read. Only fail if the unsafe value is still present.
      const remainingSharedBare = await Utils.executeGitCommand(
        ["config", "--file", sharedConfig, "--get", "core.bare"],
        { cwd },
      );
      if (remainingSharedBare.success) {
        return removeSharedBare;
      }
    }
  }

  return Utils.executeGitCommand(
    ["config", "--file", sharedConfig, "extensions.worktreeConfig", "true"],
    { cwd },
  );
}

/**
 * Prepare a worktree for an agent run: isolate git hooks, then install
 * dependencies.
 *
 * Shared by the review path (`prepareReviewWorktree`) and the fleet path
 * (`RepoManager.addWorktree`) so the two cannot drift: hook isolation must
 * always precede the install, because dependency postinstalls (lefthook)
 * rewrite the shared `.git/hooks` otherwise.
 *
 * Both steps are non-fatal and this method never throws: a missing package
 * manager on PATH or a failed install only logs a warning, so the agent
 * still starts and can attempt setup itself.
 */
export async function prepareWorktreeForAgent(
  worktreePath: string,
  options?: { verbose?: boolean },
): Promise<{ success: boolean; packageManager?: string; error?: string }> {
  const verbose = options?.verbose ?? false;

  try {
    // NOTE: `.devintern-code/` is kept out of `git add -A` by the fleet
    // worktree creator (`RepoManager.addWorktree`), which owns the local
    // `.git/info/exclude` write so review worktrees made from a user's own
    // checkout never modify the user's repository.
    // Confine hook rewrites by dependency postinstalls (lefthook) to this
    // worktree, before `bun install` gets a chance to touch the shared
    // `.git/hooks`.
    await Utils.isolateWorktreeHooks(worktreePath, { verbose });

    if (verbose) {
      console.log(`📦 Installing dependencies...`);
    }
    const installResult = await Utils.installDependencies(worktreePath, { verbose });

    if (verbose) {
      console.log(`   ✓ Dependency installation completed (success: ${installResult.success})`);
    }

    if (!installResult.success) {
      // Log warning but don't fail - Agent can still work without dependencies in some cases
      console.warn(`⚠️  Failed to install dependencies: ${installResult.error}`);
      console.warn(`   Agent may not be able to run tests or build commands`);
    }

    return installResult;
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`⚠️  Dependency preparation failed: ${message}`);
    console.warn(`   Agent may not be able to run tests or build commands`);
    return { success: false, error: message };
  }
}

/**
 * Auto-detect package managers and install project dependencies in a worktree.
 *
 * @param workingDir - Repository root to inspect
 * @param options - Verbose logging
 */
export async function installDependencies(
  workingDir: string,
  options?: { verbose?: boolean },
): Promise<{ success: boolean; packageManager?: string; error?: string }> {
  const verbose = options?.verbose ?? false;

  // Define package managers for each language/ecosystem
  const packageManagers = [
    // JavaScript/TypeScript (only with lock files)
    {
      name: "bun",
      manifestFile: "package.json",
      // Bun switched to a text `bun.lock` in 1.2; older repos still carry
      // the binary `bun.lockb`.
      lockFile: ["bun.lockb", "bun.lock"],
      command: "bun",
      args: ["install"],
    },
    {
      name: "pnpm",
      manifestFile: "package.json",
      lockFile: "pnpm-lock.yaml",
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
    },
    {
      name: "yarn",
      manifestFile: "package.json",
      lockFile: "yarn.lock",
      command: "yarn",
      args: ["install", "--frozen-lockfile"],
    },
    {
      name: "npm",
      manifestFile: "package.json",
      lockFile: "package-lock.json",
      command: "npm",
      args: ["ci"],
    },

    // Python
    {
      name: "uv",
      manifestFile: "pyproject.toml",
      lockFile: "uv.lock",
      command: "uv",
      args: ["sync"],
    },
    {
      name: "poetry",
      manifestFile: "pyproject.toml",
      lockFile: "poetry.lock",
      command: "poetry",
      args: ["install", "--no-root"],
    },
    {
      name: "pip",
      manifestFile: "requirements.txt",
      lockFile: null,
      command: "pip",
      args: ["install", "-r", "requirements.txt"],
    },
    {
      name: "pipenv",
      manifestFile: "Pipfile",
      lockFile: "Pipfile.lock",
      command: "pipenv",
      args: ["install", "--deploy"],
    },

    // Ruby
    {
      name: "bundle",
      manifestFile: "Gemfile",
      lockFile: "Gemfile.lock",
      command: "bundle",
      args: ["install"],
    },

    // Go
    {
      name: "go",
      manifestFile: "go.mod",
      lockFile: "go.sum",
      command: "go",
      args: ["mod", "download"],
    },

    // Rust
    {
      name: "cargo",
      manifestFile: "Cargo.toml",
      lockFile: "Cargo.lock",
      command: "cargo",
      args: ["fetch"],
    },

    // PHP
    {
      name: "composer",
      manifestFile: "composer.json",
      lockFile: "composer.lock",
      command: "composer",
      args: ["install", "--no-interaction"],
    },

    // Java (no lock files, so only install if we find these files)
    {
      name: "maven",
      manifestFile: "pom.xml",
      lockFile: null,
      command: "mvn",
      args: ["dependency:resolve"],
    },
    {
      name: "gradle",
      manifestFile: "build.gradle",
      lockFile: null,
      command: "gradle",
      args: ["dependencies", "--quiet"],
    },
    {
      name: "gradle",
      manifestFile: "build.gradle.kts",
      lockFile: null,
      command: "gradle",
      args: ["dependencies", "--quiet"],
    },
  ];

  // Find all applicable package managers for this project
  // Prioritize those with lock files, only use manifest-only as fallback
  const pmsWithLock = packageManagers.filter((pm) => {
    const manifestExists = existsSync(join(workingDir, pm.manifestFile));
    if (!manifestExists) return false;

    if (pm.lockFile) {
      const lockFiles = Array.isArray(pm.lockFile) ? pm.lockFile : [pm.lockFile];
      return lockFiles.some((lockFile) => existsSync(join(workingDir, lockFile)));
    }

    return false;
  });

  const pmsWithoutLock = packageManagers.filter((pm) => {
    const manifestExists = existsSync(join(workingDir, pm.manifestFile));
    if (!manifestExists) return false;

    // Only include if no lock file is required
    return pm.lockFile === null;
  });

  // Prefer package managers with lock files, otherwise use manifest-only ones
  const applicablePMs = pmsWithLock.length > 0 ? pmsWithLock : pmsWithoutLock;

  if (applicablePMs.length === 0) {
    // No package manager files found - nothing to install
    return { success: true };
  }

  // Install dependencies for each detected package manager
  const results: Array<{
    success: boolean;
    packageManager: string;
    error?: string;
  }> = [];

  for (const pm of applicablePMs) {
    if (verbose) {
      console.log(`   Installing ${pm.name} dependencies...`);
    }

    const result = await new Promise<{
      success: boolean;
      packageManager: string;
      error?: string;
    }>((resolve) => {
      const proc = spawn(pm.command, pm.args, {
        cwd: workingDir,
        stdio: verbose ? "inherit" : "pipe",
      });

      let errorOutput = "";

      if (!verbose) {
        // Must consume both stdout and stderr to prevent pipe buffer deadlock
        // When the buffer fills up (typically 64KB), the process blocks
        if (proc.stdout) {
          proc.stdout.on("data", () => {
            // Discard stdout when not verbose, just keep draining the buffer
          });
        }
        if (proc.stderr) {
          proc.stderr.on("data", (data: Buffer) => {
            errorOutput += data.toString();
          });
        }
      }

      proc.on("error", (error: NodeJS.ErrnoException) => {
        resolve({
          success: false,
          packageManager: pm.name,
          error: `Failed to run ${pm.name}: ${error.message}`,
        });
      });

      proc.on("close", (code: number | null) => {
        if (code === 0) {
          if (verbose) {
            console.log(`   ✅ ${pm.name} dependencies installed`);
          }
          resolve({
            success: true,
            packageManager: pm.name,
          });
        } else {
          resolve({
            success: false,
            packageManager: pm.name,
            error: `${pm.name} exited with code ${code}${errorOutput ? `\n${errorOutput}` : ""}`,
          });
        }
      });
    });

    results.push(result);
  }

  // Consider overall success if at least one package manager succeeded
  const anySuccess = results.some((r) => r.success);
  const allErrors = results
    .filter((r) => !r.success)
    .map((r) => r.error)
    .join("; ");

  if (anySuccess) {
    return {
      success: true,
      packageManager: results
        .filter((r) => r.success)
        .map((r) => r.packageManager)
        .join(", "),
    };
  } else {
    return {
      success: false,
      packageManager: results.map((r) => r.packageManager).join(", "),
      error: allErrors,
    };
  }
}

Object.assign(Utils, {
  isolateWorktreeHooks,
  enableWorktreeConfig,
  prepareWorktreeForAgent,
  installDependencies,
});
