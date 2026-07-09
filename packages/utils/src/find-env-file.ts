import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface FindEnvFileOptions {
  /** Optional config directory name to check first (e.g. '.devintern-code', '.devintern-pm') */
  configDirName?: string;
  /** Stop traversal at the home directory (default: true) */
  stopAtHome?: boolean;
  /** Stop traversal when reaching a .git directory (default: true) */
  stopAtGitRoot?: boolean;
  /** Starting directory (default: process.cwd()) */
  startDir?: string;
}

interface WalkUpOptions {
  stopAtHome?: boolean;
  stopAtGitRoot?: boolean;
  startDir?: string;
}

function walkUpDirectories(options: WalkUpOptions, onDir: (currentDir: string) => boolean): void {
  const { stopAtHome = true, stopAtGitRoot = true, startDir = process.cwd() } = options;

  let currentDir = resolve(startDir);
  const homeDir = process.env.HOME ? resolve(process.env.HOME) : null;

  while (true) {
    if (onDir(currentDir)) {
      return;
    }

    if (stopAtGitRoot && existsSync(join(currentDir, ".git"))) {
      break;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    if (stopAtHome && homeDir && currentDir === homeDir) {
      break;
    }

    currentDir = parentDir;
  }
}

/**
 * Find the nearest .env file by traversing up the directory tree.
 *
 * At each directory level, checks for `{configDirName}/.env` first,
 * then a plain `.env` file. Returns the path to the first match,
 * or `null` if none is found.
 *
 * Traversal stops at the filesystem root, home directory, or a .git root.
 */
export function findEnvFile(options: FindEnvFileOptions = {}): string | null {
  const { configDirName, ...walkOptions } = options;
  let found: string | null = null;

  walkUpDirectories(walkOptions, (currentDir) => {
    if (configDirName) {
      const configEnvPath = join(currentDir, configDirName, ".env");
      if (existsSync(configEnvPath)) {
        found = configEnvPath;
        return true;
      }
    }

    const plainEnvPath = join(currentDir, ".env");
    if (existsSync(plainEnvPath)) {
      found = plainEnvPath;
      return true;
    }

    return false;
  });

  return found;
}

/**
 * Find the nearest project config directory by traversing up the directory tree.
 *
 * Looks for an existing `{configDirName}` directory at each level.
 * Traversal stops at the filesystem root, home directory, or a .git root.
 */
export function findConfigDir(
  options: FindEnvFileOptions & { configDirName: string },
): string | null {
  const { configDirName, ...walkOptions } = options;
  let found: string | null = null;

  walkUpDirectories(walkOptions, (currentDir) => {
    const configDirPath = join(currentDir, configDirName);
    try {
      if (statSync(configDirPath).isDirectory()) {
        found = configDirPath;
        return true;
      }
    } catch {
      // Directory does not exist
    }

    return false;
  });

  return found;
}

/**
 * Resolve the project config directory, falling back to `{startDir}/{configDirName}`.
 */
export function resolveConfigDir(options: FindEnvFileOptions & { configDirName: string }): string {
  return findConfigDir(options) ?? join(options.startDir ?? process.cwd(), options.configDirName);
}
