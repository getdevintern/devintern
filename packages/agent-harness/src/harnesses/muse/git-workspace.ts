/**
 * Git workspace detection for Muse harness warnings.
 */

import { existsSync } from "fs";
import { join } from "path";

/**
 * Whether a directory appears to be inside a Git repository.
 *
 * @param workingDir - Workspace path.
 */
export function isGitWorkspace(workingDir: string): boolean {
  try {
    let dir = workingDir;
    for (let depth = 0; depth < 32; depth += 1) {
      if (existsSync(join(dir, ".git"))) {
        return true;
      }
      const parent = join(dir, "..");
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}
