/**
 * Interactive `devintern init` wizard: pick a tracker, paste tokens with a
 * deep link to each provider's token-creation page, validate the connection,
 * then write `.devintern-code/` via the shared scaffold.
 *
 * Prompt-loop mechanics and credential probes live in
 * `@devintern/task-trackers` (shared with `devpm init`); this module wires
 * them to the code package's step tables and scaffold.
 *
 * Runs only in interactive terminals; `devintern init --yes` (or piped stdin)
 * falls back to the non-interactive template scaffold.
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
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
import { findProjectRoot, resolveConfigDir } from "@devintern/utils";
import {
  GITHUB_PR_DOCS,
  GITHUB_PR_TOKEN_STEP,
  TRACKER_DOCS,
  TRACKER_SETUP,
  renderEnvFile,
  scaffoldProject,
} from "./init-scaffold";
import { collectReadinessChecks, renderReadinessReport } from "./readiness";
import { TRACKER_CAPABILITIES } from "./tracker-capabilities";

export { isInteractive };

type PromptFn = (question: string) => Promise<string>;
type ProbeFn = (trackerId: string, env: Record<string, string>) => Promise<void>;

export interface InitWizardUserLike {
  id: string;
  email: string | null;
}

export interface InitWizardDeps {
  /** Reads one line of user input; defaults to node:readline over stdin. */
  prompt?: PromptFn;
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
}

/** Supabase auth config matching what the CLI uses at runtime. */
function wizardSupabaseConfig(cwd: string): SupabaseAuthConfig {
  const configDir = resolveConfigDir({
    configDirName: ".devintern-code",
    startDir: cwd,
  });
  return createDefaultSupabaseAuthConfig(join(configDir, ".auth-session.json"));
}

/**
 * Post-scaffold onboarding: detect the agent CLI, offer inline sign-in, and
 * finish with a readiness checklist so the first `devintern TASK-KEY` cannot
 * fail on something init could have caught.
 */
async function runPostSetup(
  cwd: string,
  prompt: PromptFn,
  log: (message: string) => void,
  deps: InitWizardDeps,
): Promise<void> {
  // Agent CLI availability
  const agents =
    deps.listInstalledAgents?.() ??
    listInstalledHarnesses().map((h) => ({ name: h.name, displayName: h.displayName }));
  if (agents.length === 0) {
    log("\n🤖 No AI agent CLI found on your PATH.");
    log("   Install one (e.g. Claude Code), or set AGENT_CLI_PATH in .devintern-code/.env.");
  } else {
    const defaultAgent = resolveHarness({ warnDeprecated: false }).harness;
    const names = agents.map((a) => a.displayName).join(", ");
    log(
      `\n🤖 Agent CLIs detected: ${names}. Default: ${defaultAgent.displayName} ` +
        `(change with AGENT_HARNESS in .devintern-code/.env).`,
    );
  }

  // Inline sign-in offer
  const supabaseConfig = wizardSupabaseConfig(cwd);
  const getUser = deps.getUser ?? (() => getAuthenticatedUser(supabaseConfig));
  let user: InitWizardUserLike | null = null;
  try {
    user = await getUser();
  } catch {
    user = null;
  }
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
        const signedIn = await signIn();
        if (signedIn) {
          log(`✅ Signed in as ${signedIn.email || signedIn.id}`);
        } else {
          log("⚠️  Sign-in did not complete — run 'devintern login' before using those features.");
        }
      } catch (error) {
        log(
          `⚠️  Sign-in failed: ${error instanceof Error ? error.message : error}\n` +
            "   Run 'devintern login' before using worker connect or licensed features.",
        );
      }
    }
  } else {
    log(`✅ Signed in as ${user.email || user.id}`);
  }

  // Readiness checklist over the freshly written configuration
  try {
    const envPath = join(findProjectRoot({ startDir: cwd }), ".devintern-code", ".env");
    const envRecord = parseEnvContent(readFileSync(envPath, "utf8"));
    const checks = await collectReadinessChecks({
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
}

/** Run the interactive init wizard end to end. */
export async function runInitWizard(deps: InitWizardDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const probe = deps.probe ?? defaultProbe;

  log("🚀 Initializing @devintern/code for this project...");

  const projectRoot = findProjectRoot({ startDir: cwd });
  const configDir = resolve(projectRoot, ".devintern-code");
  // A config folder without .env is an incomplete setup: keep guiding. Only
  // refuse when credentials already exist (the scaffold never overwrites).
  if (existsSync(join(configDir, ".env"))) {
    // Delegate to the scaffold's refusal message (it never overwrites).
    scaffoldProject({ cwd });
    return;
  }

  let rl: import("node:readline/promises").Interface | undefined;
  let prompt = deps.prompt;
  if (!prompt) {
    const { createInterface } = await import("node:readline/promises");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    prompt = (question: string) => rl!.question(question);
  }

  try {
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
        });
        if (reused) trackerId = existing.trackerId;
      }
    }

    const reusedExisting = trackerId !== undefined;
    if (trackerId === undefined) {
      trackerId = await promptForTracker(
        prompt,
        log,
        Object.keys(TRACKER_SETUP).map((id) => ({
          id,
          displayName: TRACKER_CAPABILITIES[id]?.displayName ?? id,
        })),
      );
    }
    const steps = TRACKER_SETUP[trackerId] ?? [];

    const docs = TRACKER_DOCS[trackerId];
    if (docs) {
      log(`\n📖 Setup guide (tokens, permissions, examples): ${docs}`);
    }

    if (!reusedExisting) {
      await promptSteps(steps, prompt, log, values);
    }

    if (trackerId === "markdown") {
      log("\nℹ️  No credentials needed for the markdown tracker.");
    } else {
      await validateConnection(
        trackerId,
        values,
        steps,
        prompt,
        probe,
        log,
        ".devintern-code/.env",
      );
    }

    // Optional PR-integration token when the tracker itself is not GitHub.
    if (trackerId !== "github") {
      log(
        "\n📦 DevIntern opens pull requests on GitHub. A token enables that (skip if you use Bitbucket or want to set it up later).",
      );
      log(`   Token permissions and GitHub App setup: ${GITHUB_PR_DOCS}`);
      await promptSteps([GITHUB_PR_TOKEN_STEP], prompt, log, values);
    }

    const envContent = renderEnvFile(trackerId, values);
    if (!scaffoldProject({ cwd, envContent })) {
      return;
    }

    await runPostSetup(cwd, prompt, log, deps);

    log("\n🎉 Project initialized successfully!");
    log("\n📝 Next steps:");
    if (trackerId === "markdown") {
      const tasksDir = values.MARKDOWN_TASKS_DIR ?? "./tasks";
      log(`   1. Create ${tasksDir} and add a task file, e.g. TASK-1.md`);
      log("   2. Run 'devintern TASK-1' to start working on it");
    } else {
      log(`   1. Review ${join(configDir, ".env")} (credentials were written there)`);
      log(
        `   2. Optionally edit ${join(configDir, "settings.json")} for per-project status transitions`,
      );
      log("   3. Run 'devintern <TASK-KEY>' to start working on tasks");
    }
  } finally {
    rl?.close();
  }
}
