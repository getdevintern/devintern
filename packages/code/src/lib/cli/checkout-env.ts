/**
 * Environment bootstrap for commands scoped to the current checkout.
 *
 * A checkout registered in the workspace (`devintern init`, or a worker repo)
 * takes its env layers from the workspace instead of a project `.env`. Task
 * runs, `devintern doctor`, and `devintern sandbox` all load env through
 * {@link bootstrapCheckoutEnv} so they see the same values.
 */

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

import { getLoadedEnvPath, loadEnvironment } from "./bootstrap";
import { parseEnvFile } from "../workspace/env";
import { applyManualWorkspaceRun, findWorkspaceRepoForCheckout } from "../workspace/manual-run";
import type { ManualWorkspaceRun } from "../workspace/manual-run";
import { migrateLegacyCheckout } from "../workspace/migrate-checkout";
import { workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";

/**
 * Load the environment for a command running in the current checkout.
 *
 * @param options.envFile - Explicit `--env-file`; stays the only source of
 *                          credentials and tracker settings.
 * @param options.migrate - Move a legacy `.devintern-code/` checkout into the
 *                          workspace first, and create or migrate the
 *                          workspace's `state/code/`. Both write files, so
 *                          read-only commands (`doctor`, `sandbox`) leave it
 *                          off and never touch the workspace.
 * @returns The workspace repo the checkout belongs to, or null when unregistered
 */
export async function bootstrapCheckoutEnv(
  options: { envFile?: string; migrate?: boolean } = {},
): Promise<ManualWorkspaceRun | null> {
  if (options.migrate) await migrateLegacyCheckout();
  const run = await findWorkspaceRepoForCheckout();
  if (run) {
    applyManualWorkspaceRun(run, {
      runtimeOnly: Boolean(options.envFile),
      ensureState: Boolean(options.migrate),
    });
  }
  loadEnvironment(options.envFile, { skipProjectEnv: Boolean(run) });
  return run;
}

/** Absolute path of a repo's `env_file`, if it configures one. */
function repoEnvFilePath(run: ManualWorkspaceRun): string | null {
  const file = run.repo.envFile;
  if (!file) return null;
  return isAbsolute(file) ? file : join(run.workspaceDir, file);
}

/**
 * The file that supplied `key` for this checkout, or null when it came from
 * the shell (or nowhere).
 *
 * Registered checkouts check the workspace layers in precedence order:
 * inline `[repos.env]` (`workspace.toml`), the repo `env_file`, then the
 * shared workspace `.env`. Unregistered checkouts report the loaded `.env`
 * when it sets the key.
 */
export function checkoutEnvSource(run: ManualWorkspaceRun | null, key: string): string | null {
  if (!run) {
    const loaded = getLoadedEnvPath();
    if (!loaded) return null;
    try {
      return new RegExp(`^\\s*${key}\\s*=`, "m").test(readFileSync(loaded, "utf-8"))
        ? loaded
        : null;
    } catch {
      return null;
    }
  }
  if (run.repo.env[key] !== undefined) return workspaceConfigPath(run.workspaceDir);
  const repoFile = repoEnvFilePath(run);
  if (repoFile && parseEnvFile(repoFile)[key] !== undefined) return repoFile;
  const shared = workspaceEnvPath(run.workspaceDir);
  if (parseEnvFile(shared)[key] !== undefined) return shared;
  return null;
}

/**
 * The env file to name in `devintern doctor`'s tracker row: the file that set
 * `TASK_TRACKER`, else the repo `env_file`, else the shared workspace `.env`.
 * Unregistered checkouts keep the loaded project `.env`.
 */
export function checkoutEnvPath(run: ManualWorkspaceRun | null): string | null {
  if (!run) return getLoadedEnvPath();
  const source = checkoutEnvSource(run, "TASK_TRACKER");
  if (source) return source;
  const repoFile = repoEnvFilePath(run);
  if (repoFile && existsSync(repoFile)) return repoFile;
  const shared = workspaceEnvPath(run.workspaceDir);
  return existsSync(shared) ? shared : null;
}
