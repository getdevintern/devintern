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
import {
  defaultProbe,
  extractExistingTrackerConfig,
  isInteractive,
  promptForTracker,
  promptReuseExistingConfig,
  promptSteps,
  validateConnection,
} from "@devintern/task-trackers";
import {
  GITHUB_PR_DOCS,
  GITHUB_PR_TOKEN_STEP,
  TRACKER_DOCS,
  TRACKER_SETUP,
  renderEnvFile,
  scaffoldProject,
} from "./init-scaffold";
import { TRACKER_CAPABILITIES } from "./tracker-capabilities";

export { isInteractive };

type PromptFn = (question: string) => Promise<string>;
type ProbeFn = (trackerId: string, env: Record<string, string>) => Promise<void>;

export interface InitWizardDeps {
  /** Reads one line of user input; defaults to node:readline over stdin. */
  prompt?: PromptFn;
  /** Credential probe; defaults to a cheap authenticated API call per tracker. */
  probe?: ProbeFn;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  log?: (message: string) => void;
}

/** Run the interactive init wizard end to end. */
export async function runInitWizard(deps: InitWizardDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const probe = deps.probe ?? defaultProbe;

  log("🚀 Initializing @devintern/code for this project...");

  const configDir = resolve(cwd, ".devintern-code");
  if (existsSync(configDir)) {
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
    const pmEnvPath = resolve(cwd, ".devintern-pm", ".env");
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
