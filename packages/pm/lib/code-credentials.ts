/**
 * Tracker credentials DevIntern Code already has for a project, so `devpm
 * init` can offer to reuse them (env var names are shared).
 *
 * DevIntern Code keeps them in the workspace (`~/.devintern`): the project is
 * a `[[repos]]` entry matched by its `origin` or its directory, with values
 * layered from the shared `.env`, the repo's `env_file`, and `[repos.env]`.
 * A checkout DevIntern Code has not run in since it moved there may still
 * have `.devintern-code/.env`, which is read as a fallback.
 */

import { join } from "node:path";

import { findWorkspaceRepo, parseEnvText } from "@devintern/workspace";

import { pathExists, readFile } from "./runtime/fs.js";

/** Credentials found for a project, and where they came from. */
export interface CodeCredentials {
  env: Record<string, string>;
  /** Human-readable source, e.g. `DevIntern workspace (repo "api")`. */
  sourceLabel: string;
}

/**
 * Find DevIntern Code's credentials for the project at `cwd`.
 *
 * @param cwd - Project directory
 * @param workspaceDir - Workspace home (defaults to `~/.devintern`, or `DEVINTERN_WORKSPACE_DIR`)
 * @returns Null when the project is not registered and has no legacy config
 */
export async function findCodeCredentials(
  cwd: string,
  workspaceDir?: string,
): Promise<CodeCredentials | null> {
  const match = await findWorkspaceRepo({ dir: cwd, workspaceDir });
  if (match) {
    return { env: match.env, sourceLabel: `DevIntern workspace (repo "${match.repo.name}")` };
  }
  // Legacy location; DevIntern Code moves it into the workspace on its next run.
  const legacyPath = join(cwd, ".devintern-code", ".env");
  if (await pathExists(legacyPath)) {
    try {
      return {
        env: parseEnvText(await readFile(legacyPath)),
        sourceLabel: "@devintern/code configuration (.devintern-code/.env)",
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Render an env record as dotenv text. */
export function renderEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
