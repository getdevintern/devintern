/**
 * Interactive `devpm init` wizard and programmatic init APIs for hosts
 * (CLI, desktop main process).
 *
 * Prompt-loop mechanics and credential probes are shared with
 * `devintern init` via `@devintern/task-trackers`. Tracker step tables and
 * pure helpers live in `init-shared.ts` so the desktop renderer can import
 * them without Node filesystem APIs.
 *
 * Runs only in interactive terminals; `devpm init --yes` (or piped stdin)
 * falls back to the non-interactive template scaffold in `init.ts`.
 */

import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  PROBE_TIMEOUT_MS,
  defaultProbe,
  extractExistingTrackerConfig,
  promptForTracker,
  promptReuseExistingConfig,
  promptSteps,
  resolveWorkspaceEnvPath,
  validateConnection,
  withTimeout,
} from "@devintern/task-trackers";
import type { ExistingTrackerConfig } from "@devintern/task-trackers";
import { ensureGitignore } from "./init";
import {
  PM_TRACKER_DOCS,
  PM_TRACKER_NAMES,
  PM_TRACKER_SETUP,
  applyPmTrackerDefaults,
  listPmTrackers,
  missingRequiredPmFields,
  renderPmEnvFile,
} from "./init-shared";
import { pathExists, readFile, writeFile } from "./runtime/fs.js";

export { isInteractive } from "@devintern/task-trackers";
export type { ExistingTrackerConfig };
export {
  BUNDLED_TRELLO_API_KEY,
  PM_TRACKER_DOCS,
  PM_TRACKER_NAMES,
  PM_TRACKER_SETUP,
  applyPmTrackerDefaults,
  listPmTrackers,
  missingRequiredPmFields,
  renderPmEnvFile,
  stepLink,
  type EnvPromptStep,
  type PmTrackerInfo,
} from "./init-shared";

type PromptFn = (question: string) => Promise<string>;
type ProbeFn = (trackerId: string, env: Record<string, string>) => Promise<void>;

export interface PmInitWizardDeps {
  /** Reads one line of user input; defaults to node:readline over stdin. */
  prompt?: PromptFn;
  /** Credential probe; defaults to a cheap authenticated API call per tracker. */
  probe?: ProbeFn;
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  log?: (message: string) => void;
}

/** Error codes for programmatic (non-interactive) init used by the desktop app. */
export type PmInitErrorCode = "already_exists" | "validation" | "write_error" | "unknown_tracker";

export class PmInitError extends Error {
  readonly code: PmInitErrorCode;

  constructor(code: PmInitErrorCode, message: string) {
    super(message);
    this.name = "PmInitError";
    this.code = code;
  }
}

/** What the desktop (or other hosts) need before starting setup in `cwd`. */
export interface PmInitContext {
  configExists: boolean;
  envPath: string;
  /** Tracker credentials found in `.devintern-code/.env`, if reusable. */
  reusableFromCode: ExistingTrackerConfig | null;
  /**
   * Tracker credentials found in the DevIntern workspace `.env`
   * (`$DEVINTERN_WORKSPACE_DIR/.env`, default `~/.devintern/.env`), if reusable.
   * Hosts that do not support workspace reuse may ignore this field.
   */
  reusableFromWorkspace?: ExistingTrackerConfig | null;
  /** Workspace `.env` path inspected for {@link reusableFromWorkspace}. */
  workspaceEnvPath?: string;
}

/**
 * Inspect `cwd` for an existing pm config and reusable tracker credentials
 * from `.devintern-code/.env` or the DevIntern workspace `.env`. Used by the
 * desktop setup wizard and the interactive CLI.
 */
export async function inspectPmInitContext(cwd: string): Promise<PmInitContext> {
  const envPath = join(cwd, ".devintern-pm", ".env");
  const configExists = await pathExists(envPath);

  let reusableFromCode: ExistingTrackerConfig | null = null;
  const codeEnvPath = join(cwd, ".devintern-code", ".env");
  if (await pathExists(codeEnvPath)) {
    reusableFromCode = extractExistingTrackerConfig(await readFile(codeEnvPath), PM_TRACKER_SETUP);
  }

  let reusableFromWorkspace: ExistingTrackerConfig | null = null;
  const workspaceEnvPath = resolveWorkspaceEnvPath();
  if (await pathExists(workspaceEnvPath)) {
    reusableFromWorkspace = extractExistingTrackerConfig(
      await readFile(workspaceEnvPath),
      PM_TRACKER_SETUP,
    );
  }

  return { configExists, envPath, reusableFromCode, reusableFromWorkspace, workspaceEnvPath };
}

/** Human-readable source label for reusable workspace credentials. */
function workspaceSourceLabel(envPath: string): string {
  const home = homedir();
  const display = envPath.startsWith(`${home}${sep}`) ? `~${envPath.slice(home.length)}` : envPath;
  return `DevIntern workspace (${display})`;
}

/**
 * Probe tracker credentials the same way the CLI wizard does.
 * Markdown always succeeds without a network call.
 */
export async function probePmConnection(
  trackerId: string,
  values: Record<string, string>,
  probe: ProbeFn = defaultProbe,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (trackerId === "markdown") return { ok: true };
  if (!PM_TRACKER_SETUP[trackerId]) {
    return { ok: false, message: `Unknown tracker: ${trackerId}` };
  }
  try {
    const env = applyPmTrackerDefaults(trackerId, values);
    await withTimeout(probe(trackerId, env), PROBE_TIMEOUT_MS);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export interface WritePmProjectConfigOptions {
  cwd: string;
  trackerId: string;
  values: Record<string, string>;
  /**
   * When `.devintern-pm/.env` already exists, must be `true` to replace it.
   * Cancel/omit leaves the existing file untouched.
   */
  overwrite?: boolean;
  log?: (message: string) => void;
}

/**
 * Write `.devintern-pm/.env` and update `.gitignore` — same artifacts as
 * the interactive CLI wizard. Shared by CLI and the desktop app.
 */
export async function writePmProjectConfig(
  options: WritePmProjectConfigOptions,
): Promise<{ envPath: string }> {
  const { cwd, trackerId, overwrite = false, log = () => {} } = options;

  if (!PM_TRACKER_SETUP[trackerId]) {
    throw new PmInitError("unknown_tracker", `Unknown tracker: ${trackerId}`);
  }

  const values = applyPmTrackerDefaults(trackerId, options.values);
  const missing = missingRequiredPmFields(trackerId, values);
  if (missing.length > 0) {
    throw new PmInitError("validation", `Missing required fields: ${missing.join(", ")}`);
  }

  const envPath = join(cwd, ".devintern-pm", ".env");
  if ((await pathExists(envPath)) && !overwrite) {
    throw new PmInitError("already_exists", `Configuration already exists: ${envPath}`);
  }

  try {
    await writeFile(envPath, renderPmEnvFile(trackerId, values));
  } catch (error) {
    throw new PmInitError(
      "write_error",
      error instanceof Error ? error.message : `Failed to write ${envPath}`,
    );
  }
  log(`\n✅ Created configuration file: ${envPath}`);

  await ensureGitignore(cwd, log);
  return { envPath };
}

/** Run the interactive `devpm init` wizard end to end. */
export async function runPmInitWizard(deps: PmInitWizardDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const probe = deps.probe ?? defaultProbe;

  log("🚀 Initializing @devintern/pm for this project...");

  let rl: import("node:readline/promises").Interface | undefined;
  let prompt = deps.prompt;
  if (!prompt) {
    const { createInterface } = await import("node:readline/promises");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    prompt = (question: string) => rl!.question(question);
  }

  try {
    const { configExists, envPath, reusableFromCode, reusableFromWorkspace, workspaceEnvPath } =
      await inspectPmInitContext(cwd);
    if (configExists) {
      log(`\n⚠️  Configuration already exists: ${envPath}`);
      const answer = (await prompt("Overwrite it? (y/N): ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        log("❌ Initialization cancelled");
        return;
      }
    }

    const values: Record<string, string> = {};
    let trackerId: string | undefined;

    // Fast track: prefer the project's @devintern/code config, then fall back
    // to the DevIntern workspace config (env var names are shared).
    const reusable = reusableFromCode ?? reusableFromWorkspace ?? null;
    if (reusable) {
      const sourceLabel = reusableFromCode
        ? "@devintern/code configuration (.devintern-code/.env)"
        : workspaceSourceLabel(workspaceEnvPath ?? resolveWorkspaceEnvPath());
      const reused = await promptReuseExistingConfig(reusable, {
        sourceLabel,
        trackerName: PM_TRACKER_NAMES[reusable.trackerId] ?? reusable.trackerId,
        steps: PM_TRACKER_SETUP[reusable.trackerId] ?? [],
        prompt,
        log,
        values,
      });
      if (reused) trackerId = reusable.trackerId;
    }

    const reusedExisting = trackerId !== undefined;
    if (trackerId === undefined) {
      trackerId = await promptForTracker(prompt, log, listPmTrackers());
    }
    const steps = PM_TRACKER_SETUP[trackerId] ?? [];

    const docs = PM_TRACKER_DOCS[trackerId];
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
        { prompt, probe, log },
        ".devintern-pm/.env",
      );
    }

    await writePmProjectConfig({
      cwd,
      trackerId,
      values,
      overwrite: configExists,
      log,
    });

    log("\n🎉 Project initialized successfully!");
    log("\n📝 Next steps:");
    log("   1. Run 'devpm --interactive' to create your first task");
    if (docs) {
      log(`   2. Read the setup guide if anything is unclear: ${docs}`);
    }
  } finally {
    rl?.close();
  }
}
