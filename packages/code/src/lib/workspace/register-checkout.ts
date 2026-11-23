/**
 * Register a local checkout in the workspace as a `manual_only` repo.
 *
 * Used by `devintern init`: instead of a `.devintern-code/` folder inside the
 * checkout, the repo gets a `[[repos]]` entry in `~/.devintern/workspace.toml`
 * and its own env file under `~/.devintern/env/`. Keeping the values in a
 * per-repo file (not the shared `.env`) means a manual repo's tracker and
 * credentials never change what worker repos run with.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { parseGitLabHostAliases, parseGitRemoteUrl } from "../code-host";
import { Utils } from "../utils";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "./config";
import { deriveRepoName, ensureWorkspaceScaffold, tomlString } from "./init";
import type { WorkspaceLogFn } from "./init";
import { findRepoForOrigin } from "./manual-run";
import { workspaceConfigPath } from "./paths";

/** Workspace-relative directory holding per-repo env files written by init. */
export const REPO_ENV_DIR = "env";

/** Result of {@link registerManualCheckout}. */
export type RegisterCheckoutResult =
  | { ok: true; workspaceDir: string; repoName: string; envPath: string; created: boolean }
  | { ok: false; error: string };

/**
 * Read the checkout's `origin` remote URL.
 *
 * @returns The URL, or null outside a git repo or without an `origin`
 */
export async function readOriginRemote(cwd: string): Promise<string | null> {
  const result = await Utils.executeGitCommand(["remote", "get-url", "origin"], { cwd });
  const remote = result.success ? result.output.trim() : "";
  return remote || null;
}

/**
 * Read the checkout's `origin` when it names a recognised code-host project.
 *
 * Only such remotes can be matched back to a `[[repos]]` entry on later runs
 * (`findRepoForOrigin`), so only they are registered. A local-path or unknown
 * remote returns null and the checkout keeps the legacy `.devintern-code/`.
 */
export async function readRegistrableOrigin(cwd: string): Promise<string | null> {
  const remote = await readOriginRemote(cwd);
  if (!remote) return null;
  const options = {
    gitlabBaseUrl: process.env.GITLAB_CODE_HOST_URL,
    gitlabHostAliases: parseGitLabHostAliases(process.env.GITLAB_CODE_HOST_ALIASES),
  };
  return parseGitRemoteUrl(remote, options) ? remote : null;
}

/**
 * Add the checkout at `cwd` to the workspace with `envContent` as its env.
 *
 * Creates the workspace when missing. Refuses when the checkout's `origin` is
 * already registered (re-running init edits that repo's env instead) or when
 * the target env file already exists.
 *
 * @param cwd - Repository checkout
 * @param envContent - Full env file content the wizard (or template) produced
 * @param log - Status messages
 */
export async function registerManualCheckout(
  cwd: string,
  envContent: string,
  log: WorkspaceLogFn = console.log,
): Promise<RegisterCheckoutResult> {
  const remote = await readRegistrableOrigin(cwd);
  if (!remote) {
    return {
      ok: false,
      error: "This checkout has no GitHub, GitLab, or Bitbucket origin remote to register.",
    };
  }

  const { workspaceDir, configPath, created } = ensureWorkspaceScaffold(log);
  const text = readFileSync(configPath, "utf8");
  const config = parseWorkspaceConfig(text, configPath);
  const existing = findRepoForOrigin(config, remote, workspaceDir);
  if (existing) {
    return {
      ok: false,
      error: `${remote} is already registered in ${configPath} as "${existing.name}".`,
    };
  }

  const repoName = deriveRepoName(remote, config.repos);
  const envFile = `${REPO_ENV_DIR}/${repoName}.env`;
  const envPath = join(workspaceDir, envFile);
  if (existsSync(envPath)) {
    return { ok: false, error: `${envPath} already exists; remove it or register by hand.` };
  }

  const block =
    `\n[[repos]]\nname = ${tomlString(repoName)}\nremote = ${tomlString(remote)}\n` +
    `# Run by hand from your checkout only; the worker skips this repo.\n` +
    `manual_only = true\nenv_file = ${tomlString(envFile)}\n`;
  const updated = text.endsWith("\n") ? text + block : `${text}\n${block}`;
  // Validate before writing anything.
  parseWorkspaceConfig(updated, configPath);

  mkdirSync(join(workspaceDir, REPO_ENV_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(envPath, envContent, { encoding: "utf8", mode: 0o600 });
  chmodSync(envPath, 0o600);
  writeFileSync(configPath, updated);
  loadWorkspaceConfig(workspaceConfigPath(workspaceDir));

  log(`✅ Registered ${remote} as "${repoName}" in ${configPath}`);
  log(`   Settings for this repo: ${envPath}`);
  return { ok: true, workspaceDir, repoName, envPath, created };
}
