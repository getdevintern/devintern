/**
 * Interactive `devintern init` wizard: pick a tracker, paste tokens with a
 * deep link to each provider's token-creation page, validate the connection,
 * then register the checkout in `~/.devintern` with its own env file.
 *
 * Prompt-loop mechanics and credential probes live in
 * `@devintern/task-trackers` (shared with `devpm init`); this module wires
 * them to the code package's step tables and scaffold.
 *
 * Runs only in interactive terminals; `devintern init --yes` (or piped stdin)
 * falls back to the non-interactive template scaffold.
 */

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { listInstalledHarnesses, resolveHarness } from "@devintern/agent-harness";
import {
  createDefaultSupabaseAuthConfig,
  getAuthenticatedUser,
  isLoginSkipped,
  login,
  resolveLogin,
} from "@devintern/auth";
import type { SupabaseAuthConfig } from "@devintern/auth";
import {
  PROBE_TIMEOUT_MS,
  condenseMessage,
  defaultProbe,
  extractExistingTrackerConfig,
  isInteractive,
  parseEnvContent,
  promptForTracker,
  promptReuseExistingConfig,
  promptSteps,
  validateConnection,
  withTimeout,
} from "@devintern/task-trackers";
import { findProjectRoot, upsertEnvVars } from "@devintern/utils";
import { signInCommand, workerLoginCommandFor } from "../account/worker-pilot";
import { isPromptAbort } from "../cli/prompt-abort";
import { resolveWizardPrompts } from "../cli/prompt-session";
import type { PromptSession } from "../cli/prompt-session";
import { resolveProjectConfigDir } from "../config/config-dir";
import type { SetupSignInStatus, SetupSource } from "../observability/analytics";
import {
  trackSetupCompleted,
  trackSetupFailed,
  trackSetupStarted,
} from "../observability/analytics";
import {
  GITHUB_PR_DOCS,
  GITHUB_PR_TOKEN_STEP,
  TRACKER_DOCS,
  TRACKER_SETUP,
  renderEnvFile,
} from "./scaffold";
import type { EnvPromptStep } from "./scaffold";
import { collectReadinessChecks, renderReadinessReport } from "../observability/readiness";
import type { ReadinessCheck } from "../observability/readiness";
import { describeGitHubCliToken, readGitHubCliToken } from "./github-cli-token";
import type { GitHubCliToken } from "./github-cli-token";
import { TRACKER_CAPABILITIES } from "../trackers/capabilities";
import { gitHubSlugFromRemote } from "../workspace/env";
import { workspaceCodeStateDir, workspaceConfigPath } from "../workspace/paths";
import { findWorkspaceRepoForCheckout } from "../workspace/manual-run";
import { readOriginRemote, registerManualCheckout } from "../workspace/register-checkout";
import { writeSecretFile } from "../utils/secret-file";

export { isInteractive };

type PromptFn = (question: string) => Promise<string>;
type LogFn = (message: string) => void;
type ProbeFn = (trackerId: string, env: Record<string, string>) => Promise<void>;

export interface InitWizardUserLike {
  id: string;
  email: string | null;
}

export interface InitWizardDeps {
  /** Reads one line of user input; defaults to node:readline over stdin. */
  prompt?: PromptFn;
  /** Reads a token without echoing it; defaults to `prompt` when `prompt` is injected. */
  promptSecret?: PromptFn;
  /** Credential probe; defaults to a cheap authenticated API call per tracker. */
  probe?: ProbeFn;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  log?: (message: string) => void;
  /** Session lookup override; defaults to a real local Supabase session read. */
  getUser?: () => Promise<InitWizardUserLike | null>;
  /**
   * Interactive sign-in override; defaults to the full `devintern login`
   * flow (provider picker + browser callback, Enter skips the wait).
   */
  signIn?: () => Promise<InitWizardUserLike | null>;
  /** Installed agent CLIs; defaults to PATH probing of every harness. */
  listInstalledAgents?: () => Array<{ name: string; displayName: string }>;
  /** Reads a signed-in GitHub CLI token; defaults to `gh auth token` (tests inject null). */
  githubCliToken?: () => GitHubCliToken | null;
  /**
   * Which entry point opened the wizard — `init` command or the first-run
   * rescue offer — recorded on setup analytics events.
   */
  source?: SetupSource;
}

/** Where init wrote this checkout's configuration. */
export interface InitTarget {
  /** Env file holding the tracker credentials and agent settings. */
  envPath: string;
  /** Workspace home when the checkout was registered in the workspace. */
  workspaceDir?: string;
}

/** Supabase auth config matching what the CLI uses at runtime. */
function wizardSupabaseConfig(cwd: string, target?: InitTarget): SupabaseAuthConfig {
  const stateDir = target?.workspaceDir
    ? workspaceCodeStateDir(target.workspaceDir)
    : resolveProjectConfigDir(cwd);
  return createDefaultSupabaseAuthConfig(join(stateDir, ".auth-session.json"));
}

/**
 * Post-scaffold onboarding: detect the agent CLI, offer inline sign-in, and
 * finish with a readiness checklist so the first `devintern TASK-KEY` cannot
 * fail on something init could have caught.
 *
 * @returns The sign-in outcome and readiness checks (when collectible) for
 *   the setup analytics event
 */
async function runPostSetup(
  cwd: string,
  session: Pick<PromptSession, "prompt" | "guard">,
  log: (message: string) => void,
  deps: InitWizardDeps,
  target: InitTarget,
): Promise<{ signedIn: SetupSignInStatus; checks?: ReadinessCheck[] }> {
  const { prompt } = session;
  // Agent CLI availability
  const agents =
    deps.listInstalledAgents?.() ??
    listInstalledHarnesses().map((h) => ({ name: h.name, displayName: h.displayName }));
  if (agents.length === 0) {
    log("\n🤖 No AI agent CLI found on your PATH.");
    log(`   Install one (e.g. Claude Code), or set AGENT_CLI_PATH in ${target.envPath}.`);
  } else {
    const defaultAgent = resolveHarness({ warnDeprecated: false }).harness;
    const names = agents.map((a) => a.displayName).join(", ");
    log(
      `\n🤖 Agent CLIs detected: ${names}. Default: ${defaultAgent.displayName} ` +
        `(change with AGENT_HARNESS in ${target.envPath}).`,
    );
  }

  // Inline sign-in offer
  const supabaseConfig = wizardSupabaseConfig(cwd, target);
  const getUser = deps.getUser ?? (() => getAuthenticatedUser(supabaseConfig));
  let user: InitWizardUserLike | null = null;
  try {
    user = await getUser();
  } catch {
    user = null;
  }
  let signedIn: SetupSignInStatus = "skipped";
  const later = signInCommand(
    target.workspaceDir
      ? workerLoginCommandFor(workspaceConfigPath(target.workspaceDir))
      : undefined,
  );
  if (!user) {
    const answer = await prompt(
      "\nSign in to DevIntern now? Enables worker connect and license entitlements. [Y/n] ",
    );
    if (answer.trim().toLowerCase() !== "n") {
      const signIn =
        deps.signIn ??
        (async () => {
          const resolved = await resolveLogin(process.argv);
          return login(supabaseConfig, resolved, { skipCommand: later });
        });
      try {
        const signedUp = await session.guard(signIn());
        if (signedUp) {
          log(`✅ Signed in as ${signedUp.email || signedUp.id}`);
          signedIn = "success";
        } else {
          signedIn = "failed";
          log(`⚠️  Sign-in did not complete — run \`${later}\` before using those features.`);
        }
      } catch (error) {
        // Closed input stops the whole wizard, not just the sign-in step.
        if (isPromptAbort(error)) {
          log(
            `\n⏸️  Setup stopped at sign-in. Your tracker settings are saved in ${target.envPath}.`,
          );
          log(`   Sign in later with \`${later}\`; \`devintern doctor\` checks the rest.`);
          throw error;
        }
        if (isLoginSkipped(error)) {
          log(`⏭️  Sign-in skipped. Sign in later with \`${later}\`.`);
        } else {
          signedIn = "failed";
          log(
            `⚠️  Sign-in failed: ${error instanceof Error ? error.message : error}\n` +
              `   Run \`${later}\` before using worker connect or licensed features.`,
          );
        }
      }
    }
  } else {
    log(`✅ Signed in as ${user.email || user.id}`);
    signedIn = "success";
  }

  // Readiness checklist over the freshly written configuration
  let checks: ReadinessCheck[] | undefined;
  try {
    const envPath = target.envPath;
    const envRecord = parseEnvContent(readFileSync(envPath, "utf8"));
    checks = await collectReadinessChecks({
      env: { ...process.env, ...envRecord },
      envPath,
    });
    const report = renderReadinessReport(checks);
    log("\n📋 Readiness:");
    for (const line of report.lines) {
      log(`   ${line}`);
    }
  } catch {
    // Summary is best-effort; never fail init over it.
  }
  return { signedIn, checks };
}

/** Run the interactive init wizard end to end. */
export async function runInitWizard(deps: InitWizardDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const probe = deps.probe ?? defaultProbe;

  log("🚀 Initializing @getdevintern/code for this project...");

  // Re-running init on a registered checkout edits its env file instead
  // (`devintern init` routes there); never prompt for a second registration.
  const registered = await findWorkspaceRepoForCheckout({ cwd });
  if (registered) {
    log(`ℹ️  This checkout is already registered as "${registered.repo.name}".`);
    log("   Run `devintern init` in a terminal to update its settings.");
    return;
  }

  const session = await resolveWizardPrompts(deps);
  const { prompt, promptSecret } = session;

  // The checkout is registered in the workspace as a manual-only repo (by its
  // origin, or by its directory when it has no recognised remote).
  let workspaceDir = "";
  const writeEnv = async (envContent: string): Promise<string | null> => {
    const registered = await registerManualCheckout(cwd, envContent, log);
    if (!registered.ok) {
      log(`❌ ${registered.error}`);
      return null;
    }
    workspaceDir = registered.workspaceDir;
    return registered.envPath;
  };

  try {
    trackSetupStarted(deps.source ?? "init");
    const origin = await readOriginRemote(cwd);
    const originSlug = origin ? gitHubSlugFromRemote(origin) : null;
    const result = await runTrackerSetup(prompt, log, probe, cwd, {
      writeEnv,
      promptSecret,
      stepDefaults: originSlug ? { GITHUB_REPO: originSlug } : undefined,
      ...(deps.githubCliToken ? { githubCliToken: deps.githubCliToken } : {}),
    });
    if (!result) {
      trackSetupFailed("scaffold_refused");
      return;
    }
    const target: InitTarget = { envPath: result.envPath, workspaceDir };

    const postSetup = await runPostSetup(cwd, session, log, deps, target);
    trackSetupCompleted({
      tracker: result.trackerId,
      signedIn: postSetup.signedIn,
      checks: postSetup.checks,
    });

    log("\n🎉 Project initialized successfully!");
    log("\n📝 Next steps:");
    if (result.trackerId === "markdown") {
      const tasksDir = result.values.MARKDOWN_TASKS_DIR ?? "./tasks";
      log(`   1. Create ${tasksDir} and add a task file, e.g. TASK-1.md`);
      log("   2. Run 'devintern TASK-1' to start working on it");
    } else {
      log(`   1. Review ${target.envPath} (credentials were written there)`);
      log(
        `   2. Optionally add [trackers] status names to ${join(workspaceDir, "workspace.toml")}`,
      );
      log("   3. Run 'devintern <TASK-KEY>' to start working on tasks");
    }
  } finally {
    session.close();
  }
}

/**
 * Save `MARKDOWN_TASKS_DIR` as an absolute path. The worker service runs from
 * the workspace directory and each task from its checkout, so a relative
 * folder would point somewhere different for each of them; resolve it from
 * where the user ran setup, which is what they meant.
 */
export function absolutizeMarkdownTasksDir(
  values: Record<string, string>,
  cwd: string,
  log: LogFn,
): void {
  const dir = values.MARKDOWN_TASKS_DIR;
  if (!dir) return;
  const absolute = isAbsolute(dir) ? dir : resolve(cwd, dir);
  values.MARKDOWN_TASKS_DIR = absolute;
  if (absolute !== dir) log(`   Saved as the absolute path ${absolute}`);
  if (!existsSync(absolute)) {
    log(`   ℹ️  ${absolute} does not exist yet: create it and add your task files there.`);
  }
}

/** Outcome of offering a signed-in `gh` token: absent, declined, rejected, or accepted. */
export type GitHubCliTokenOffer =
  | { status: "accepted"; token: string; session: GitHubCliToken }
  | { status: "declined" }
  | { status: "rejected"; reason: string }
  | { status: "unavailable" };

/**
 * Offer a signed-in GitHub CLI token in place of pasting one.
 *
 * The token is probed with the same tracker probe as a pasted token (repo
 * access when a repository is known) before the offer, so a token the API
 * rejects is never written to any env file. The result separates a declined
 * offer from a rejected token so callers can fall back to the normal prompt
 * only when the user did not want the token.
 */
export async function offerGitHubCliToken(options: {
  token: GitHubCliToken | null;
  prompt: PromptFn;
  log: LogFn;
  probe: ProbeFn;
  repoSlug?: string;
}): Promise<GitHubCliTokenOffer> {
  const { token, prompt, log, probe, repoSlug } = options;
  if (!token) return { status: "unavailable" };
  const env: Record<string, string> = { GITHUB_TOKEN: token.token };
  if (repoSlug) env.GITHUB_REPO = repoSlug;
  try {
    await withTimeout(probe("github", env), PROBE_TIMEOUT_MS);
  } catch (error) {
    const reason = condenseMessage(error instanceof Error ? error.message : String(error));
    log(`⚠️  Not using the GitHub CLI token: ${reason}`);
    return { status: "rejected", reason };
  }
  const answer = (
    await prompt(`Use your GitHub CLI token (${describeGitHubCliToken(token)})? [Y/n]: `)
  )
    .trim()
    .toLowerCase();
  if (answer === "n" || answer === "no") return { status: "declined" };
  return { status: "accepted", token: token.token, session: token };
}

/**
 * Offer a signed-in `gh` token in place of the `GITHUB_TOKEN` prompt.
 *
 * @returns true when the token was accepted and written into `values`
 */
async function reuseGitHubCliToken(options: {
  values: Record<string, string>;
  stepDefaults?: Record<string, string>;
  readGh: () => GitHubCliToken | null;
  prompt: PromptFn;
  log: LogFn;
  probe: ProbeFn;
}): Promise<boolean> {
  if (options.values.GITHUB_TOKEN || process.env.GITHUB_TOKEN) return false;
  const token = options.readGh();
  const offer = await offerGitHubCliToken({
    token,
    prompt: options.prompt,
    log: options.log,
    probe: options.probe,
    repoSlug:
      options.values.GITHUB_REPO || options.stepDefaults?.GITHUB_REPO || process.env.GITHUB_REPO,
  });
  if (offer.status !== "accepted") return false;
  options.values.GITHUB_TOKEN = offer.token;
  options.log(`🔑 Using your GitHub CLI token (${describeGitHubCliToken(offer.session)}).`);
  return true;
}

/** Turn stored values into Enter-to-keep prompt step defaults. */
function prefillSteps(steps: EnvPromptStep[], existing: Record<string, string>): EnvPromptStep[] {
  return steps.map((step) => {
    const current = existing[step.key];
    if (!current) return step;
    return {
      ...step,
      defaultValue: current,
      label: `${step.label} (Enter to keep current)`,
    };
  });
}

/**
 * Offer the CLI token for a tracker that needs one, then return its prompt
 * steps without the token step when the offer was accepted.
 */
async function trackerTokenSteps(options: {
  trackerId: string;
  steps: EnvPromptStep[];
  existing: Record<string, string>;
  values: Record<string, string>;
  readGh: () => GitHubCliToken | null;
  prompt: PromptFn;
  log: LogFn;
  probe: ProbeFn;
}): Promise<EnvPromptStep[]> {
  const { existing, values } = options;
  if (options.trackerId === "github" && !existing.GITHUB_TOKEN) {
    await reuseGitHubCliToken(options);
  }
  const steps = prefillSteps(options.steps, existing);
  return values.GITHUB_TOKEN ? steps.filter((step) => step.key !== "GITHUB_TOKEN") : steps;
}

/** Intro shown before offering or prompting for the optional pull-request token. */
export function logGitHubPrTokenIntro(log: LogFn): void {
  log(
    "\n📦 DevIntern opens pull requests on GitHub. A token enables that (skip if you use Bitbucket or want to set it up later).",
  );
  log(`   Token permissions and GitHub App setup: ${GITHUB_PR_DOCS}`);
}

/** Offer the optional PR token, falling back to the pasted-token prompt. */
async function promptGitHubPrToken(options: {
  values: Record<string, string>;
  existing: Record<string, string>;
  readGh: () => GitHubCliToken | null;
  prompt: PromptFn;
  promptSecret: PromptFn;
  log: LogFn;
  probe: ProbeFn;
}): Promise<void> {
  logGitHubPrTokenIntro(options.log);
  const reused = await reuseGitHubCliToken({ ...options, stepDefaults: options.existing });
  if (!reused) {
    await promptSteps(
      [GITHUB_PR_TOKEN_STEP],
      options.prompt,
      options.log,
      options.values,
      options.promptSecret,
    );
  }
}

/**
 * Tracker-only subset of `devintern init`: pick a tracker, collect credentials,
 * validate, and scaffold `.devintern-code/`. Used by `devintern init` and by
 * `devintern worker init` when the repo has no tracker config yet.
 *
 * @returns Tracker id and collected values, or null when scaffolding refused
 */
export async function runTrackerSetup(
  prompt: PromptFn,
  log: LogFn,
  probe: ProbeFn,
  cwd: string,
  options: {
    /** Write the collected env content; returns the written path, or null to refuse. */
    writeEnv: (envContent: string) => Promise<string | null>;
    /** Hidden-input prompt for tokens; defaults to `prompt`. */
    promptSecret?: PromptFn;
    /** Enter-for-default answers by env key (e.g. `GITHUB_REPO` from origin). */
    stepDefaults?: Record<string, string>;
    /** Where the values are saved, named when validation is skipped. */
    envLabel?: string;
    /** Reads a signed-in GitHub CLI token; defaults to `gh auth token`. */
    githubCliToken?: () => GitHubCliToken | null;
    /**
     * Offer the optional PR token when the tracker is not GitHub (default
     * true). `worker init` sets this false and offers it in its own later step,
     * so a declined offer is not repeated.
     */
    offerPrToken?: boolean;
  },
): Promise<{ trackerId: string; values: Record<string, string>; envPath: string } | null> {
  const projectRoot = findProjectRoot({ startDir: cwd });
  const promptSecret = options.promptSecret ?? prompt;
  const readGh = options.githubCliToken ?? readGitHubCliToken;
  const values: Record<string, string> = {};
  let trackerId: string | undefined;

  // Fast track: reuse tracker credentials from an existing @devintern/pm
  // config in the same project (env var names are shared).
  const pmEnvPath = resolve(projectRoot, ".devintern-pm", ".env");
  if (existsSync(pmEnvPath)) {
    const existing = extractExistingTrackerConfig(readFileSync(pmEnvPath, "utf8"), TRACKER_SETUP);
    if (existing) {
      const reused = await promptReuseExistingConfig(existing, {
        sourceLabel: "@devintern/pm configuration (.devintern-pm/.env)",
        trackerName: TRACKER_CAPABILITIES[existing.trackerId]?.displayName ?? existing.trackerId,
        steps: TRACKER_SETUP[existing.trackerId] ?? [],
        prompt,
        log,
        values,
        promptSecret,
      });
      if (reused) trackerId = existing.trackerId;
    }
  }

  const reusedExisting = trackerId !== undefined;
  if (trackerId === undefined) {
    // Zero-account path first: markdown needs no credentials, so evaluators
    // can reach a first successful run in minutes.
    const otherIds = Object.keys(TRACKER_SETUP).filter((id) => id !== "markdown");
    trackerId = await promptForTracker(prompt, log, [
      {
        id: "markdown",
        displayName: "Markdown files",
        hint: "local .md task files, no account needed — quickest way to try DevIntern",
      },
      ...otherIds.map((id) => ({
        id,
        displayName: TRACKER_CAPABILITIES[id]?.displayName ?? id,
      })),
    ]);
  }
  const steps = TRACKER_SETUP[trackerId] ?? [];

  const docs = TRACKER_DOCS[trackerId];
  if (docs) {
    log(`\n📖 Setup guide (tokens, permissions, examples): ${docs}`);
  }

  // Origin defaults apply to the first pass and to "edit values" after a
  // failed connection check alike.
  const prompted = steps.map((step) => {
    const fallback = options.stepDefaults?.[step.key];
    return fallback ? { ...step, defaultValue: fallback } : step;
  });
  if (!reusedExisting) {
    // The GitHub tracker needs a token; offer a signed-in `gh` session before
    // asking them to create one. A rejected token falls back to the prompt.
    if (trackerId === "github") {
      await reuseGitHubCliToken({
        values,
        stepDefaults: options.stepDefaults,
        readGh,
        prompt,
        log,
        probe,
      });
    }
    const stepsToPrompt = values.GITHUB_TOKEN
      ? prompted.filter((step) => step.key !== "GITHUB_TOKEN")
      : prompted;
    await promptSteps(stepsToPrompt, prompt, log, values, promptSecret);
  }

  if (trackerId === "markdown") {
    absolutizeMarkdownTasksDir(values, cwd, log);
    log("\nℹ️  No credentials needed for the markdown tracker.");
  } else {
    await validateConnection(
      trackerId,
      values,
      prompted,
      { prompt, probe, log, promptSecret },
      options.envLabel ?? "this repo's env file in ~/.devintern/env/",
    );
  }

  // Optional PR-integration token when the tracker itself is not GitHub.
  if (trackerId !== "github" && (options.offerPrToken ?? true)) {
    log(
      "\n📦 DevIntern opens pull requests on GitHub. A token enables that (skip if you use Bitbucket or want to set it up later).",
    );
    log(`   Token permissions and GitHub App setup: ${GITHUB_PR_DOCS}`);
    const reused = await reuseGitHubCliToken({
      values,
      stepDefaults: options.stepDefaults,
      readGh,
      prompt,
      log,
      probe,
    });
    if (!reused) {
      await promptSteps([GITHUB_PR_TOKEN_STEP], prompt, log, values, promptSecret);
    }
  }

  const envContent = renderEnvFile(trackerId, values);
  const envPath = await options.writeEnv(envContent);
  return envPath ? { trackerId, values, envPath } : null;
}

/**
 * Re-run `devintern init` over an existing configuration: update the current
 * tracker's credentials (existing values become Enter-to-keep defaults) or
 * switch trackers, preserving unrelated lines in `.env`.
 *
 * Values are merged with {@link upsertEnvVars} instead of rewriting the file,
 * so comments, custom vars, and previously-skipped optionals survive.
 */
export async function runInitUpgrade(
  deps: InitWizardDeps & {
    /** Env file to update (the repo's `env_file` in the workspace). */
    envPath: string;
  },
): Promise<void> {
  const log = deps.log ?? console.log;
  const probe = deps.probe ?? defaultProbe;
  const cwd = deps.cwd ?? process.cwd();
  const envPath = deps.envPath;
  const envLabel = envPath;
  const readGh = deps.githubCliToken ?? readGitHubCliToken;

  if (!existsSync(envPath)) {
    log(`⚠️  ${envPath} not found — nothing to upgrade.`);
    return;
  }

  const originalContent = readFileSync(envPath, "utf8");
  const existing = parseEnvContent(originalContent);
  const currentTracker = (existing.TASK_TRACKER || "jira").toLowerCase();
  const currentName = TRACKER_CAPABILITIES[currentTracker]?.displayName ?? currentTracker;

  const session = await resolveWizardPrompts(deps);
  const { prompt, promptSecret } = session;

  try {
    log("🔧 Existing devintern configuration found.");
    log("\nWhat would you like to do?");
    log(`   1. Update ${currentName} credentials`);
    log("   2. Switch to a different task tracker");
    log("   3. Exit without changes");

    let choice: string | undefined;
    for (;;) {
      const answer = (await prompt("Enter a number (1-3): ")).trim();
      if (answer === "1" || answer === "2" || answer === "3") {
        choice = answer;
        break;
      }
      log(`❌ Invalid choice: '${answer}'. Pick 1-3.`);
    }
    if (choice === "3") {
      log("No changes made.");
      return;
    }

    if (choice === "1") {
      const steps = TRACKER_SETUP[currentTracker] ?? [];
      const docs = TRACKER_DOCS[currentTracker];
      if (docs) log(`\n📖 Setup guide: ${docs}`);
      const values: Record<string, string> = {};
      const stepsToPrompt = await trackerTokenSteps({
        trackerId: currentTracker,
        steps,
        existing,
        values,
        readGh,
        prompt,
        log,
        probe,
      });
      await promptSteps(stepsToPrompt, prompt, log, values, promptSecret);
      absolutizeMarkdownTasksDir(values, cwd, log);

      // Optional PR-integration token, kept from config when present.
      if (currentTracker !== "github" && !existing.GITHUB_TOKEN) {
        await promptGitHubPrToken({
          values,
          existing,
          readGh,
          prompt,
          promptSecret,
          log,
          probe,
        });
      }

      if (currentTracker !== "markdown") {
        await validateConnection(
          currentTracker,
          { ...existing, ...values },
          steps,
          { prompt, probe, log, promptSecret },
          envLabel,
        );
      }

      writeSecretFile(envPath, upsertEnvVars(originalContent, values));
      log(`\n✅ Updated ${envLabel}`);
      return;
    }

    // Switch tracker
    const trackerId = await promptForTracker(
      prompt,
      log,
      Object.keys(TRACKER_SETUP)
        .filter((id) => id !== currentTracker)
        .map((id) => ({
          id,
          displayName: TRACKER_CAPABILITIES[id]?.displayName ?? id,
        })),
    );
    const steps = TRACKER_SETUP[trackerId] ?? [];
    const docs = TRACKER_DOCS[trackerId];
    if (docs) log(`\n📖 Setup guide (tokens, permissions, examples): ${docs}`);

    const values: Record<string, string> = {};
    const stepsToPrompt = await trackerTokenSteps({
      trackerId,
      steps,
      existing,
      values,
      readGh,
      prompt,
      log,
      probe,
    });
    await promptSteps(stepsToPrompt, prompt, log, values, promptSecret);
    absolutizeMarkdownTasksDir(values, cwd, log);
    if (trackerId !== "github" && existing.GITHUB_TOKEN) {
      // Carry the PR token over so GitHub integration keeps working.
      values.GITHUB_TOKEN = existing.GITHUB_TOKEN;
    } else if (trackerId !== "github") {
      await promptGitHubPrToken({
        values,
        existing,
        readGh,
        prompt,
        promptSecret,
        log,
        probe,
      });
    }

    if (trackerId !== "markdown") {
      await validateConnection(
        trackerId,
        values,
        steps,
        { prompt, probe, log, promptSecret },
        envLabel,
      );
    }

    writeSecretFile(
      envPath,
      upsertEnvVars(originalContent, { TASK_TRACKER: trackerId, ...values }),
    );
    log(
      `\n✅ Switched to ${
        TRACKER_CAPABILITIES[trackerId]?.displayName ?? trackerId
      } in ${envLabel}`,
    );
  } finally {
    session.close();
  }
}
