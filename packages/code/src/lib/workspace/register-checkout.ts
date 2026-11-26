/**
 * Register a local checkout in the workspace as a `manual_only` repo.
 *
 * Used by `devintern init`: instead of a `.devintern-code/` folder inside the
 * checkout, the repo gets a `[[repos]]` entry in `~/.devintern/workspace.toml`
 * and its own env file under `~/.devintern/env/`. Keeping the values in a
 * per-repo file (not the shared `.env`) means a manual repo's tracker and
 * credentials never change what worker repos run with.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { parseEnvContent } from "@devintern/task-trackers";
import { findProjectRoot } from "@devintern/utils";

import { parseGitLabHostAliases, parseGitRemoteUrl } from "../code-host";
import { Utils } from "../utils";
import { writeSecretFile } from "../utils/secret-file";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "./config";
import { supportsPolling } from "../trackers/capabilities";
import {
  deriveRepoName,
  ensureWorkspaceScaffold,
  tomlString,
  upsertWorkspaceDefaults,
} from "./init";
import type { WorkspaceLogFn } from "./init";
import { findRepoForCheckout } from "./manual-run";
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
 * remote returns null, and the checkout is registered by its directory instead.
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
 * The entry is keyed by the checkout's `origin` when it is a recognised
 * code-host remote, otherwise by the checkout directory (`path`), so a fresh
 * `git init` or a non-git folder can be registered too. Creates the workspace
 * when missing. Refuses when the checkout is already registered (re-running
 * init edits that repo's env instead) or when the target env file exists.
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
  const checkoutDir = findProjectRoot({ startDir: cwd });

  const { workspaceDir, configPath, created } = ensureWorkspaceScaffold(log);
  const text = readFileSync(configPath, "utf8");
  const config = parseWorkspaceConfig(text, configPath);
  const existing = findRepoForCheckout(config, { origin: remote, dir: checkoutDir }, workspaceDir);
  if (existing) {
    return {
      ok: false,
      error: `${remote ?? checkoutDir} is already registered in ${configPath} as "${existing.name}".`,
    };
  }

  const repoName = deriveRepoName(remote ?? checkoutDir, config.repos);
  const envFile = `${REPO_ENV_DIR}/${repoName}.env`;
  const envPath = join(workspaceDir, envFile);
  if (existsSync(envPath)) {
    return { ok: false, error: `${envPath} already exists; remove it or register by hand.` };
  }

  const block =
    `\n[[repos]]\nname = ${tomlString(repoName)}\n` +
    (remote ? `remote = ${tomlString(remote)}\n` : `path = ${tomlString(checkoutDir)}\n`) +
    `# Run by hand from your checkout only; the worker skips this repo.\n` +
    `manual_only = true\nenv_file = ${tomlString(envFile)}\n`;
  let updated = text.endsWith("\n") ? text + block : `${text}\n${block}`;
  // A workspace created just now carries the template's tracker; record the
  // one this checkout uses, so a later `worker init` starts from it.
  const tracker = parseEnvContent(envContent).TASK_TRACKER?.toLowerCase();
  if (created && tracker && supportsPolling(tracker)) {
    updated = upsertWorkspaceDefaults(updated, { tracker });
  }
  // Validate before writing anything.
  parseWorkspaceConfig(updated, configPath);

  mkdirSync(join(workspaceDir, REPO_ENV_DIR), { recursive: true, mode: 0o700 });
  writeSecretFile(envPath, envContent);
  writeFileSync(configPath, updated);
  loadWorkspaceConfig(workspaceConfigPath(workspaceDir));

  log(`✅ Registered ${remote ?? checkoutDir} as "${repoName}" in ${configPath}`);
  log(`   Settings for this repo: ${envPath}`);
  return { ok: true, workspaceDir, repoName, envPath, created };
}
