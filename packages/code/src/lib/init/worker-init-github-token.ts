/**
 * The worker wizard's pull-request token step: reuse a token already in the
 * workspace `.env` or the shell, offer the signed-in GitHub CLI session, or
 * prompt for one.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";

import { defaultProbe, parseEnvContent, promptSteps } from "@devintern/task-trackers";
import { upsertEnvVars } from "@devintern/utils";

import { Utils } from "../utils";
import { writeSecretFile } from "../utils/secret-file";
import { loadWorkspaceConfig } from "../workspace/config";
import { gitHubSlugFromRemote } from "../workspace/env";
import { workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import { describeGitHubCliToken, readGitHubCliToken } from "./github-cli-token";
import type { GitHubCliToken } from "./github-cli-token";
import { GITHUB_PR_TOKEN_STEP, TRACKER_SETUP } from "./scaffold";
import type { LogFn } from "./worker-init-policy";
import type { PromptRun, SetupRun } from "./worker-init-run";
import { logGitHubPrTokenIntro, offerGitHubCliToken } from "./wizard";

/**
 * Pull-request token. When the tracker is not GitHub, the worker still opens
 * pull requests on GitHub, so ask for the optional token as before. When the
 * workspace `.env` has no token, offer the signed-in `gh` session; a token
 * only exported in the shell is saved to the workspace `.env` so the service
 * (which does not inherit the shell) can use it. The GitHub tracker gets the
 * same shell-token persistence even though its token normally comes from the
 * tracker step: an existing workspace whose `.env` already names the tracker
 * skips that step, so a removed or expired token is recovered here, and a
 * `GITHUB_TOKEN` that only the shell exports is saved too. Flags mode resolved
 * all of this while planning the query.
 */
export async function githubTokenStep(run: SetupRun): Promise<boolean> {
  if (run.input === "flags") return true;
  const envPath = workspaceEnvPath(run.workspaceDir);
  const existing = existsSync(envPath) ? parseEnvContent(readFileSync(envPath, "utf8")) : {};
  if (existing.GITHUB_TOKEN) return true;
  if (process.env.GITHUB_TOKEN) {
    // The installed service carries only PATH and DEVINTERN_WORKSPACE_DIR, so a
    // shell export would be lost when the worker starts; persist it instead.
    saveGitHubToken(envPath, process.env.GITHUB_TOKEN, run.log);
    return true;
  }
  // The GitHub tracker's token normally comes from the tracker step, but that
  // step returns early for an existing workspace whose `.env` has TASK_TRACKER.
  const githubTracker = run.trackerType === "github";
  if (!githubTracker) logGitHubPrTokenIntro(run.log);
  const repoSlug = await githubSlugForWorkspace(run);

  let token: GitHubCliToken | null;
  try {
    token = (run.deps.githubCliToken ?? readGitHubCliToken)();
  } catch {
    token = null;
  }
  const offer = await offerGitHubCliToken({
    token,
    prompt: run.prompt,
    log: run.log,
    probe: run.deps.githubTokenProbe ?? defaultProbe,
    repoSlug,
  });
  if (offer.status === "accepted") {
    run.log(`🔑 Using your GitHub CLI token (${describeGitHubCliToken(offer.session)}).`);
    saveGitHubToken(envPath, offer.token, run.log);
    return true;
  }
  // No usable `gh` session (absent, signed out, declined, or rejected): ask for
  // a token as before. The rejection warning is already logged when the probe
  // refused it; for the optional PR token an empty answer still skips it, while
  // the GitHub tracker's own token is required.
  const tokenStep = githubTracker
    ? (TRACKER_SETUP.github?.find((step) => step.key === "GITHUB_TOKEN") ?? GITHUB_PR_TOKEN_STEP)
    : GITHUB_PR_TOKEN_STEP;
  const values: Record<string, string> = {};
  await promptSteps([tokenStep], run.prompt, run.log, values, run.promptSecret);
  if (values.GITHUB_TOKEN) saveGitHubToken(envPath, values.GITHUB_TOKEN, run.log);
  return true;
}

/** `owner/repo` of this workspace's GitHub remote, for the PR-token probe. */
async function githubSlugForWorkspace(run: PromptRun): Promise<string | undefined> {
  const origin = await originGitHubSlug(run.cwd);
  if (origin) return origin;
  try {
    const config = loadWorkspaceConfig(workspaceConfigPath(run.workspaceDir));
    for (const repo of config.repos) {
      const slug = gitHubSlugFromRemote(repo.remote);
      if (slug) return slug;
    }
  } catch {
    // An unreadable workspace is reported by the workspace step.
  }
  return undefined;
}

/**
 * Save `GITHUB_TOKEN` to the workspace `.env` with owner-only permissions.
 *
 * Every earlier assignment is removed first (including a commented template
 * placeholder): `upsertEnvVars` replaces only the first match, and
 * `parseEnvFile` reads the last, so leaving a duplicate would make a later
 * `--env-file` rotation rewrite one line while the old token still won.
 */
function saveGitHubToken(envPath: string, token: string, log: LogFn): void {
  const existingText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const withoutToken = existingText
    .split("\n")
    .filter((line) => !/^\s*#?\s*(?:export\s+)?GITHUB_TOKEN=/.test(line))
    .join("\n");
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  writeSecretFile(envPath, upsertEnvVars(withoutToken, { GITHUB_TOKEN: token }));
  process.env.GITHUB_TOKEN = token;
  log(`💾 Saved GITHUB_TOKEN to ${envPath}`);
}

/** `owner/repo` of the checkout's GitHub `origin`, or null (no origin, not GitHub). */
export async function originGitHubSlug(cwd: string): Promise<string | null> {
  const result = await Utils.executeGitCommand(["remote", "get-url", "origin"], { cwd });
  const remote = result.success ? result.output.trim() : "";
  return remote ? gitHubSlugFromRemote(remote) : null;
}
