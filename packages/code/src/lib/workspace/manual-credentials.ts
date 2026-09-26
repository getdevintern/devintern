import { existsSync } from "fs";

import { parseChangeRequestUrl, parseGitLabHostAliases, parseGitRemoteUrl } from "../code-host";
import { isWorkerSubprocess } from "../config/config-dir";
import { Utils } from "../utils";
import { loadWorkspaceConfig } from "./config";
import { buildRepoCredentialEnv } from "./env";
import { resolveWorkspaceDir, workspaceConfigPath } from "./paths";

/** Worker-owned runtime paths must not move a manual command's local state. */
const WORKER_RUNTIME_KEYS = [
  "DEVINTERN_WORKSPACE_DIR",
  "DEVINTERN_WORKER_SUBPROCESS",
  "DEVINTERN_WORKSPACE_REPO",
  "DEVINTERN_WORKSPACE_TEAM",
  "DEVINTERN_ANALYTICS_CONFIG_DIR",
  "WEBHOOK_QUEUE_DB",
];

/**
 * Find workspace credentials only when both the current origin and the PR/MR
 * URL identify the same registered repository. This keeps credentials for a
 * different workspace repository out of the manual command.
 */
export async function workspaceCredentialsForChange(
  changeUrl: string,
  options: { cwd?: string; workspaceDir?: string } = {},
): Promise<Record<string, string> | null> {
  if (isWorkerSubprocess()) return null; // already has its composed environment
  const workspaceDir = options.workspaceDir ?? resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) return null;

  const originResult = await Utils.executeGitCommand(["remote", "get-url", "origin"], {
    cwd: options.cwd,
  });
  if (!originResult.success) return null;

  const config = loadWorkspaceConfig(configPath);
  for (const repo of config.repos) {
    const credentials = buildRepoCredentialEnv(repo, workspaceDir);
    const gitlabBaseUrl = credentials.GITLAB_CODE_HOST_URL ?? process.env.GITLAB_CODE_HOST_URL;
    const parseOptions = {
      gitlabBaseUrl,
      gitlabHostAliases: parseGitLabHostAliases(
        credentials.GITLAB_CODE_HOST_ALIASES ?? process.env.GITLAB_CODE_HOST_ALIASES,
      ),
    };
    const current = parseGitRemoteUrl(originResult.output.trim(), parseOptions);
    const registered = parseGitRemoteUrl(repo.remote, parseOptions);
    const change = parseChangeRequestUrl(changeUrl, { gitlabBaseUrl });
    if (!current || !registered || !change) continue;
    const projectPath = (path: string) =>
      change.provider === "github" ? path.toLowerCase() : path;
    if (
      current.provider !== change.provider ||
      registered.provider !== change.provider ||
      current.instanceUrl !== change.instanceUrl ||
      registered.instanceUrl !== change.instanceUrl ||
      projectPath(current.projectPath) !== projectPath(change.projectPath) ||
      projectPath(registered.projectPath) !== projectPath(change.projectPath)
    ) {
      continue;
    }

    for (const key of WORKER_RUNTIME_KEYS) delete credentials[key];
    return credentials;
  }
  return null;
}
