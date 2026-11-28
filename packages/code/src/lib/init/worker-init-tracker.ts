/**
 * The worker wizard's tracker configuration: reuse the settings `devintern
 * init` or an earlier `worker init` saved, run that subset of `devintern
 * init` when there are none, ask them again when the query step goes back
 * here, and say when GitHub Issues live in another repository than the code.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import { createPromptAttempts, defaultProbe, parseEnvContent } from "@devintern/task-trackers";
import { findProjectRoot } from "@devintern/utils";

import { TRACKER_CAPABILITIES } from "../trackers/capabilities";
import { trackerRepoNotice } from "../trackers/github/tracker-repo-notice";
import { trackerRequiredEnv } from "../trackers/manager";
import { writeSecretFile } from "../utils/secret-file";
import { loadWorkspaceConfig } from "../workspace/config";
import { gitHubSlugFromRemote } from "../workspace/env";
import { findWorkspaceRepoForCheckout } from "../workspace/manual-run";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "../workspace/paths";
import type { GitHubCliToken } from "./github-cli-token";
import { originGitHubSlug } from "./worker-init-github-token";
import type { LogFn, PromptFn } from "./worker-init-policy";
import type { PromptRun } from "./worker-init-run";
import { runTrackerSetup, updateTrackerCredentials } from "./wizard";

/** How often one wizard run may go back from the query step to the tracker step. */
export const MAX_TRACKER_REVISITS = 3;

export function trackerDisplayName(tracker: string): string {
  return TRACKER_CAPABILITIES[tracker]?.displayName ?? tracker;
}

/**
 * The query step could not run the query because of the credentials or
 * repository access: go back to the tracker step, or keep the query and fix
 * the settings by hand. Not offered again after {@link MAX_TRACKER_REVISITS}.
 *
 * @returns true to go back
 */
export async function askBackToTracker(run: PromptRun): Promise<boolean> {
  if ((run.trackerRevisits ?? 0) >= MAX_TRACKER_REVISITS) return false;
  const reject = createPromptAttempts("query step choice");
  for (;;) {
    const answer = (await run.prompt("[b]ack to the tracker step / [k]eep and fix later [b]: "))
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "b" || answer === "back") {
      run.trackerRevisits = (run.trackerRevisits ?? 0) + 1;
      return true;
    }
    if (answer === "k" || answer === "keep") return false;
    run.log(`❌ Invalid choice: '${answer}'. Enter b or k.`);
    reject("No valid choice; enter b (back to the tracker step) or k (keep and fix later)");
  }
}

/**
 * The tracker step again, after the query step went back: ask the current
 * tracker's settings with the saved values as Enter defaults, validate them,
 * update the workspace `.env`, and apply them to this process so the next
 * dry run uses them.
 */
export async function reconfigureTracker(run: PromptRun): Promise<boolean> {
  run.log(`   Update the ${run.trackerName} settings; press Enter to keep a value.`);
  if (run.deps.reconfigureTracker) {
    return run.deps.reconfigureTracker({
      cwd: run.cwd,
      trackerType: run.trackerType,
      workspaceDir: run.workspaceDir,
      prompt: run.prompt,
      promptSecret: run.promptSecret,
      log: run.log,
    });
  }
  const values = await updateTrackerCredentials({
    trackerId: run.trackerType,
    envPath: workspaceEnvPath(run.workspaceDir || resolveWorkspaceDir()),
    cwd: run.cwd,
    prompt: run.prompt,
    promptSecret: run.promptSecret,
    log: run.log,
    probe: defaultProbe,
    ...(run.deps.githubCliToken ? { githubCliToken: run.deps.githubCliToken } : {}),
    // The worker's own GitHub-token step offers the PR token.
    offerPrToken: false,
  });
  // The new values must win over the ones applied earlier in this run.
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return true;
}

/**
 * GitHub Issues in a repository other than this checkout and the
 * workspace's repositories: a legitimate split, or a typo in GITHUB_REPO.
 * Say which repository tickets come from and which gets the PRs.
 */
export async function noteTrackerRepo(run: PromptRun): Promise<void> {
  if (run.trackerType !== "github") return;
  const prRepos: (string | null)[] = [];
  try {
    prRepos.push(await originGitHubSlug(run.cwd));
  } catch {
    // No origin: the workspace's repositories still count.
  }
  try {
    const configPath = workspaceConfigPath(run.workspaceDir || resolveWorkspaceDir());
    if (existsSync(configPath)) {
      for (const repo of loadWorkspaceConfig(configPath).repos) {
        prRepos.push(gitHubSlugFromRemote(repo.remote));
      }
    }
  } catch {
    // An unreadable workspace is reported by the workspace step.
  }
  const notice = trackerRepoNotice(process.env.GITHUB_REPO, prRepos);
  if (notice) {
    run.log(`ℹ️  ${notice}. That is fine if intended; otherwise fix GITHUB_REPO.`);
  }
}

function applyEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }
  const env = parseEnvContent(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    // Match dotenv's normal precedence: an explicit shell value wins.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return env;
}

export async function defaultEnsureTracker(
  cwd: string,
  prompt: PromptFn,
  promptSecret: PromptFn,
  log: LogFn,
  githubCliToken?: () => GitHubCliToken | null,
): Promise<string | null> {
  // A legacy checkout `.env` is reused once; `add-repo` merges it into the
  // workspace env in the next step.
  const projectRoot = findProjectRoot({ startDir: cwd });
  const legacyEnvPath = resolve(projectRoot, ".devintern-code", ".env");
  if (existsSync(legacyEnvPath)) {
    const env = applyEnvFile(legacyEnvPath);
    return (env.TASK_TRACKER || process.env.TASK_TRACKER || "jira").toLowerCase();
  }

  // An existing workspace that already names a tracker needs no setup.
  const sharedEnvPath = workspaceEnvPath(resolveWorkspaceDir());
  const shared = applyEnvFile(sharedEnvPath);
  if (shared.TASK_TRACKER) return shared.TASK_TRACKER.toLowerCase();

  // `worker init --non-interactive` records the tracker in `[defaults].tracker`
  // (workspace.toml is the source of truth) and its credentials in the workspace
  // `.env`, without TASK_TRACKER. Treat that pair as configured.
  const workspaceDir = resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  const configured = existsSync(configPath) ? loadWorkspaceConfig(configPath).defaults.tracker : "";
  if (
    configured &&
    trackerRequiredEnv(configured).every((key) => shared[key] || process.env[key])
  ) {
    log(`   Using ${configured} from ${configPath}`);
    // The later steps (query dry run, readiness) build their client from this.
    process.env.TASK_TRACKER ??= configured.toLowerCase();
    return configured.toLowerCase();
  }

  // `devintern init` saved this checkout's tracker in its own env file
  // (`~/.devintern/env/<repo>.env`). The worker polls with the workspace
  // `.env`, so copy those settings there instead of asking for them again.
  const reused = await reuseCheckoutTrackerEnv(cwd, workspaceDir, sharedEnvPath, log);
  if (reused) return reused;

  log("   No tracker config yet — running that subset of `devintern init`.");
  const originSlug = await originGitHubSlug(cwd);
  const result = await runTrackerSetup(prompt, log, defaultProbe, cwd, {
    promptSecret,
    envLabel: sharedEnvPath,
    stepDefaults: originSlug ? { GITHUB_REPO: originSlug } : undefined,
    // The worker's own GitHub-token step offers this after the workspace is
    // known, so a declined offer is not repeated here.
    offerPrToken: false,
    ...(githubCliToken ? { githubCliToken } : {}),
    writeEnv: async (envContent) => {
      mergeIntoSharedEnv(sharedEnvPath, envContent, log);
      return sharedEnvPath;
    },
  });
  if (!result) {
    return null;
  }
  applyEnvFile(sharedEnvPath);
  return result.trackerId;
}

/**
 * Reuse the tracker settings `devintern init` saved for the checkout at `cwd`
 * (its `[[repos]]` entry's `env_file`): when they name a tracker and hold its
 * required keys, merge them into the workspace `.env` and apply them.
 *
 * @returns The tracker id, or null when the checkout has no usable settings
 */
async function reuseCheckoutTrackerEnv(
  cwd: string,
  workspaceDir: string,
  sharedEnvPath: string,
  log: LogFn,
): Promise<string | null> {
  let envFile: string | undefined;
  try {
    envFile = (await findWorkspaceRepoForCheckout({ cwd, workspaceDir }))?.repo.envFile;
  } catch {
    return null;
  }
  if (!envFile) return null;
  const envPath = resolve(workspaceDir, envFile);
  if (!existsSync(envPath)) return null;
  const content = readFileSync(envPath, "utf8");
  const env = parseEnvContent(content);
  const tracker = env.TASK_TRACKER?.toLowerCase();
  if (!tracker || !trackerRequiredEnv(tracker).every((key) => env[key])) return null;
  log(`   Using ${trackerDisplayName(tracker)} from ${envPath} (saved by \`devintern init\`).`);
  mergeIntoSharedEnv(sharedEnvPath, content, log);
  applyEnvFile(sharedEnvPath);
  return tracker;
}

/**
 * Merge wizard output into the workspace's shared `.env`: keys it lacks are
 * appended; keys it already has are kept (other repos rely on them) and a
 * differing value is reported instead of overwritten.
 */
function mergeIntoSharedEnv(envPath: string, envContent: string, log: LogFn): void {
  const incoming = parseEnvContent(envContent);
  const existingText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const existing = parseEnvContent(existingText);
  const additions: string[] = [];
  const differing: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in existing)) additions.push(`${key}=${value}`);
    else if (existing[key] !== value) differing.push(key);
  }
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  const separator = existingText === "" || existingText.endsWith("\n") ? "" : "\n";
  writeSecretFile(
    envPath,
    existingText + separator + additions.map((line) => `${line}\n`).join(""),
  );
  log(`   Saved tracker settings to ${envPath}`);
  if (differing.length > 0) {
    log(
      `   ⚠️  Kept the existing values for: ${differing.join(", ")} (edit ${envPath} to change them).`,
    );
  }
}
