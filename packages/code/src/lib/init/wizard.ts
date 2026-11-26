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
  login,
  resolveLogin,
} from "@devintern/auth";
import type { SupabaseAuthConfig } from "@devintern/auth";
import {
  defaultProbe,
  extractExistingTrackerConfig,
  isInteractive,
  parseEnvContent,
  promptForTracker,
  promptReuseExistingConfig,
  promptSteps,
  validateConnection,
} from "@devintern/task-trackers";
import { findProjectRoot, upsertEnvVars } from "@devintern/utils";
import { isPromptAbort } from "../cli/prompt-abort";
import { resolveWizardPrompts } from "../cli/prompt-session";
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
import { collectReadinessChecks, renderReadinessReport } from "../observability/readiness";
import type { ReadinessCheck } from "../observability/readiness";
import { TRACKER_CAPABILITIES } from "../trackers/capabilities";
import { workspaceCodeStateDir } from "../workspace/paths";
import { findWorkspaceRepoForCheckout } from "../workspace/manual-run";
import { registerManualCheckout } from "../workspace/register-checkout";
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
   * flow (provider picker + browser callback).
   */
  signIn?: () => Promise<InitWizardUserLike | null>;
  /** Installed agent CLIs; defaults to PATH probing of every harness. */
  listInstalledAgents?: () => Array<{ name: string; displayName: string }>;
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
  prompt: PromptFn,
  log: (message: string) => void,
  deps: InitWizardDeps,
  target: InitTarget,
): Promise<{ signedIn: SetupSignInStatus; checks?: ReadinessCheck[] }> {
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
  if (!user) {
    const answer = await prompt(
      "\nSign in to DevIntern now? Enables worker connect and license entitlements. [Y/n] ",
    );
    if (answer.trim().toLowerCase() !== "n") {
      const signIn =
        deps.signIn ??
        (async () => {
          const resolved = await resolveLogin(process.argv);
          return login(supabaseConfig, resolved);
        });
      try {
        const signedUp = await signIn();
        if (signedUp) {
          log(`✅ Signed in as ${signedUp.email || signedUp.id}`);
          signedIn = "success";
        } else {
          signedIn = "failed";
          log("⚠️  Sign-in did not complete — run 'devintern login' before using those features.");
        }
      } catch (error) {
        // Closed input stops the whole wizard, not just the sign-in step.
        if (isPromptAbort(error)) throw error;
        signedIn = "failed";
        log(
          `⚠️  Sign-in failed: ${error instanceof Error ? error.message : error}\n` +
            "   Run 'devintern login' before using worker connect or licensed features.",
        );
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

  log("🚀 Initializing @devintern/code for this project...");

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
    const result = await runTrackerSetup(prompt, log, probe, cwd, { writeEnv, promptSecret });
    if (!result) {
      trackSetupFailed("scaffold_refused");
      return;
    }
    const target: InitTarget = { envPath: result.envPath, workspaceDir };

    const postSetup = await runPostSetup(cwd, prompt, log, deps, target);
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
  },
): Promise<{ trackerId: string; values: Record<string, string>; envPath: string } | null> {
  const projectRoot = findProjectRoot({ startDir: cwd });
  const promptSecret = options.promptSecret ?? prompt;
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

  if (!reusedExisting) {
    await promptSteps(steps, prompt, log, values, promptSecret);
  }

  if (trackerId === "markdown") {
    absolutizeMarkdownTasksDir(values, cwd, log);
    log("\nℹ️  No credentials needed for the markdown tracker.");
  } else {
    await validateConnection(
      trackerId,
      values,
      steps,
      { prompt, probe, log, promptSecret },
      "this repo's env file in ~/.devintern/",
    );
  }

  // Optional PR-integration token when the tracker itself is not GitHub.
  if (trackerId !== "github") {
    log(
      "\n📦 DevIntern opens pull requests on GitHub. A token enables that (skip if you use Bitbucket or want to set it up later).",
    );
    log(`   Token permissions and GitHub App setup: ${GITHUB_PR_DOCS}`);
    await promptSteps([GITHUB_PR_TOKEN_STEP], prompt, log, values, promptSecret);
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

    /** Turn stored values into Enter-to-keep prompt step defaults. */
    const prefill = (steps: (typeof TRACKER_SETUP)[string]) =>
      steps.map((step) => {
        const current = existing[step.key];
        if (!current) return step;
        return {
          ...step,
          defaultValue: current,
          label: `${step.label} (Enter to keep current)`,
        };
      });

    if (choice === "1") {
      const steps = TRACKER_SETUP[currentTracker] ?? [];
      const docs = TRACKER_DOCS[currentTracker];
      if (docs) log(`\n📖 Setup guide: ${docs}`);
      const values: Record<string, string> = {};
      await promptSteps(prefill(steps), prompt, log, values, promptSecret);
      absolutizeMarkdownTasksDir(values, cwd, log);

      // Optional PR-integration token, kept from config when present.
      if (currentTracker !== "github" && !existing.GITHUB_TOKEN) {
        log(
          "\n📦 DevIntern opens pull requests on GitHub. A token enables that (skip if you use Bitbucket or want to set it up later).",
        );
        log(`   Token permissions and GitHub App setup: ${GITHUB_PR_DOCS}`);
        await promptSteps([GITHUB_PR_TOKEN_STEP], prompt, log, values, promptSecret);
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
    await promptSteps(prefill(steps), prompt, log, values, promptSecret);
    absolutizeMarkdownTasksDir(values, cwd, log);
    if (trackerId !== "github" && existing.GITHUB_TOKEN) {
      // Carry the PR token over so GitHub integration keeps working.
      values.GITHUB_TOKEN = existing.GITHUB_TOKEN;
    } else if (trackerId !== "github") {
      log(
        "\n📦 DevIntern opens pull requests on GitHub. A token enables that (skip if you use Bitbucket or want to set it up later).",
      );
      log(`   Token permissions and GitHub App setup: ${GITHUB_PR_DOCS}`);
      await promptSteps([GITHUB_PR_TOKEN_STEP], prompt, log, values, promptSecret);
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
