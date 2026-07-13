/**
 * Shared building blocks for the interactive `init` wizards in
 * `@devintern/code` and `@devintern/pm`: credential prompt steps, tracker
 * selection, and connection validation with retry/edit/skip UX.
 *
 * Each CLI owns its per-tracker step tables and file scaffolding; this module
 * owns the prompt loop mechanics and the per-tracker credential probes (which
 * reuse the API clients in this package).
 */

import { BUNDLED_TRELLO_API_KEY } from "../config/load-tracker-config.ts";
import {
  AsanaClient,
  AzureDevOpsClient,
  GitHubClient,
  JiraClient,
  LinearClient,
  TrelloClient,
} from "../clients/index.ts";

export const PROBE_TIMEOUT_MS = 10_000;
export const MAX_EDIT_ATTEMPTS = 3;

export type PromptFn = (question: string) => Promise<string>;
export type ProbeFn = (trackerId: string, env: Record<string, string>) => Promise<void>;
export type LogFn = (message: string) => void;

/** One credential/config prompt in an init wizard. */
export interface EnvPromptStep {
  /** Environment variable name. */
  key: string;
  /** Human-readable label shown in the prompt. */
  label: string;
  /** Token-creation deep link, printed before the prompt. May depend on earlier answers. */
  link?: string | ((values: Record<string, string>) => string);
  /** Press Enter to skip; written commented-out in `.env`. */
  optional?: boolean;
  /** Example value shown in the prompt and template. */
  example?: string;
  /** Default applied when the user presses Enter. */
  defaultValue?: string;
}

/** Resolve a step's deep link, which may depend on earlier answers. */
export function stepLink(step: EnvPromptStep, values: Record<string, string>): string | undefined {
  if (!step.link) return undefined;
  return typeof step.link === "function" ? step.link(values) : step.link;
}

/** Whether `init` should run the interactive wizard. */
export function isInteractive(argv: string[], stdin: { isTTY?: boolean }): boolean {
  return !argv.includes("--yes") && !argv.includes("--no-interactive") && stdin.isTTY === true;
}

/** Cheap authenticated API call per tracker to validate pasted credentials. */
export async function defaultProbe(trackerId: string, env: Record<string, string>): Promise<void> {
  switch (trackerId) {
    case "jira":
      await new JiraClient(
        env.JIRA_BASE_URL ?? "",
        env.JIRA_EMAIL ?? "",
        env.JIRA_API_TOKEN ?? "",
      ).getProjects();
      return;
    case "linear":
      await new LinearClient({ apiKey: env.LINEAR_API_KEY ?? "" }).getTeams();
      return;
    case "github": {
      const [owner, repo] = (env.GITHUB_REPO || "/").split("/");
      await new GitHubClient({
        token: env.GITHUB_TOKEN ?? "",
        owner: owner ?? "",
        repo: repo ?? "",
      }).getRepositories();
      return;
    }
    case "azure-devops":
      await new AzureDevOpsClient({
        organization: env.AZURE_DEVOPS_ORG ?? "",
        pat: env.AZURE_DEVOPS_PAT ?? "",
        defaultProject: env.AZURE_DEVOPS_PROJECT ?? "",
      }).getProjects();
      return;
    case "asana":
      await new AsanaClient({ apiToken: env.ASANA_API_TOKEN ?? "" }).getProjects();
      return;
    case "trello":
      await new TrelloClient({
        apiKey: env.TRELLO_API_KEY || BUNDLED_TRELLO_API_KEY,
        apiToken: env.TRELLO_API_TOKEN ?? "",
      }).getBoards();
      return;
    default:
      // markdown and unknown trackers have nothing to probe
      return;
  }
}

export function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    promise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Connection check timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

/** A tracker menu entry: id plus the display name shown to the user. */
export interface TrackerChoice {
  id: string;
  displayName: string;
}

/** Ask which tracker to use, accepting a menu number or a tracker id. */
export async function promptForTracker(
  prompt: PromptFn,
  log: LogFn,
  trackers: TrackerChoice[],
): Promise<string> {
  const trackerIds = trackers.map((t) => t.id);
  log("\nWhich task tracker do you use?");
  trackers.forEach((tracker, index) => {
    log(`   ${index + 1}. ${tracker.displayName} (${tracker.id})`);
  });

  for (;;) {
    const answer = (await prompt(`Enter a number (1-${trackerIds.length}) or tracker id: `)).trim();
    const byNumber = trackerIds[parseInt(answer, 10) - 1];
    if (byNumber && /^\d+$/.test(answer)) return byNumber;
    if (trackerIds.includes(answer.toLowerCase())) return answer.toLowerCase();
    log(
      `❌ Invalid choice: '${answer}'. Pick 1-${trackerIds.length} or one of: ${trackerIds.join(", ")}`,
    );
  }
}

/** Run a table of prompt steps, collecting answers into `values`. */
export async function promptSteps(
  steps: EnvPromptStep[],
  prompt: PromptFn,
  log: LogFn,
  values: Record<string, string>,
): Promise<void> {
  for (const step of steps) {
    const link = stepLink(step, values);
    if (link) {
      log(`\n🔗 Create your ${step.label.toLowerCase()} at:\n   ${link}`);
    }
    const hints: string[] = [];
    if (step.example) hints.push(`e.g. ${step.example}`);
    if (step.defaultValue) hints.push(`Enter for default`);
    else if (step.optional) hints.push("optional, Enter to skip");
    const suffix = hints.length > 0 ? ` (${hints.join("; ")})` : "";

    for (;;) {
      const answer = (await prompt(`${step.label}${suffix}: `)).trim();
      if (answer) {
        values[step.key] = answer;
        break;
      }
      if (step.defaultValue) {
        values[step.key] = step.defaultValue;
        break;
      }
      if (step.optional) {
        delete values[step.key];
        break;
      }
      log(`❌ ${step.key} is required.`);
    }
  }
}

/** Parse simple KEY=value lines from an env file, ignoring comments. */
export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/** Tracker credentials found in a sibling DevIntern product's `.env`. */
export interface ExistingTrackerConfig {
  trackerId: string;
  values: Record<string, string>;
}

/**
 * Extract reusable tracker credentials from a sibling DevIntern product's
 * `.env` (env var names are shared across @devintern/code and @devintern/pm).
 *
 * @returns null when the file's tracker is unknown to `setup` or none of its
 * step values are present
 */
export function extractExistingTrackerConfig(
  envContent: string,
  setup: Record<string, EnvPromptStep[]>,
): ExistingTrackerConfig | null {
  const env = parseEnvContent(envContent);
  const trackerId = env.TASK_TRACKER || "jira";
  const steps = setup[trackerId];
  if (!steps) return null;
  const values: Record<string, string> = {};
  for (const step of steps) {
    const value = env[step.key];
    if (value) values[step.key] = value;
  }
  return Object.keys(values).length > 0 ? { trackerId, values } : null;
}

/**
 * Fast track: offer to reuse credentials found in a sibling product's config.
 * On accept, copies them into `values` and prompts only for required steps
 * the existing config does not cover.
 *
 * @returns true when accepted (skip tracker selection and credential
 * prompts), false to run the normal flow
 */
export async function promptReuseExistingConfig(
  existing: ExistingTrackerConfig,
  opts: {
    /** Where the config came from, e.g. "@devintern/code (.devintern-code/.env)". */
    sourceLabel: string;
    trackerName: string;
    steps: EnvPromptStep[];
    prompt: PromptFn;
    log: LogFn;
    values: Record<string, string>;
  },
): Promise<boolean> {
  const { sourceLabel, trackerName, steps, prompt, log, values } = opts;
  log(`\n📋 Found an existing ${sourceLabel} for ${trackerName}.`);
  const answer = (await prompt("Reuse those credentials? (Y/n): ")).trim().toLowerCase();
  if (answer === "n" || answer === "no") return false;
  Object.assign(values, existing.values);
  const missing = steps.filter((step) => !step.optional && !values[step.key]);
  if (missing.length > 0) {
    await promptSteps(missing, prompt, log, values);
  }
  return true;
}

/**
 * Validate credentials with retry/edit/skip UX.
 *
 * @param envPath - Path mentioned in the skip warning so users know where to
 * fix values later (e.g. `.devintern-pm/.env`).
 * @returns true when validated (or skipped), false is never returned — the
 * loop only exits via success or explicit skip
 */
export async function validateConnection(
  trackerId: string,
  values: Record<string, string>,
  steps: EnvPromptStep[],
  prompt: PromptFn,
  probe: ProbeFn,
  log: LogFn,
  envPath: string,
): Promise<boolean> {
  let edits = 0;
  for (;;) {
    log("\n🔌 Checking the connection...");
    try {
      await withTimeout(probe(trackerId, values), PROBE_TIMEOUT_MS);
      log("✅ Connection verified.");
      return true;
    } catch (error) {
      log(`❌ Connection check failed: ${error instanceof Error ? error.message : error}`);
      const canEdit = edits < MAX_EDIT_ATTEMPTS;
      const choices = canEdit
        ? "[r]etry / [e]dit values / [s]kip validation"
        : "[r]etry / [s]kip validation";
      const answer = (await prompt(`What next? ${choices}: `)).trim().toLowerCase();
      if (answer === "s") {
        log(`⚠️  Skipping validation. The values will be written as-is; verify them in ${envPath}`);
        return true;
      }
      if (answer === "e" && canEdit) {
        edits++;
        await promptSteps(steps, prompt, log, values);
      }
      // anything else (including 'r') retries with current values
    }
  }
}
