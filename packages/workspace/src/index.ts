/**
 * Read access to the DevIntern workspace (`~/.devintern`) for every product:
 * where it lives, which `[[repos]]` entry a checkout belongs to, and that
 * repo's credential env. Node-compatible (no Bun APIs), so `devpm` and the
 * desktop app can use it.
 */

export { parseEnvText, readEnvFile } from "./env-file.ts";
export { findWorkspaceRepo, readOriginRemote } from "./lookup.ts";
export type { WorkspaceRepoMatch } from "./lookup.ts";
export { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "./paths.ts";
export {
  matchWorkspaceRepo,
  normalizeRemote,
  parseWorkspaceFile,
  readWorkspaceFile,
  repoCredentialEnv,
} from "./repos.ts";
export type { WorkspaceFile, WorkspaceRepo } from "./repos.ts";
