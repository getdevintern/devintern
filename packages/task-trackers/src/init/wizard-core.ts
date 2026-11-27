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
  GitLabClient,
  JiraClient,
  LinearClient,
  TrelloClient,
} from "../clients/index.ts";

export const PROBE_TIMEOUT_MS = 10_000;
export const MAX_EDIT_ATTEMPTS = 3;

/**
 * Unusable answers one prompt loop tolerates before the wizard stops.
 * Interactive users who press Enter a couple of times by mistake are still
 * re-asked; a scripted or non-TTY prompt that always answers "" (or an
 * invalid menu choice) fails instead of looping forever.
 */
export const MAX_PROMPT_ATTEMPTS = 3;

/**
 * A prompt kept returning an unusable answer, so its loop stopped. A
 * scripted caller that answers the same invalid value to every prompt would
 * otherwise hang (and grow memory without bound).
 */
export class PromptAttemptsExceededError extends Error {
  /** Env var key, tracker id, or setting the prompt was collecting. */
  readonly promptKey: string;

  constructor(promptKey: string, message = `${promptKey} is required`) {
    super(message);
    this.name = "PromptAttemptsExceededError";
    this.promptKey = promptKey;
  }
}

/**
 * Count unusable answers to one prompt. Call the returned function for each
 * answer the loop refuses; after {@link MAX_PROMPT_ATTEMPTS} it throws
 * {@link PromptAttemptsExceededError}.
 *
 * @param promptKey - Step key or setting named in the default error
 * @param message - Clear explanation used instead of `<key> is required`
 */
export function createPromptAttempts(
  promptKey: string,
  message?: string,
): (overrideMessage?: string) => void {
  let attempts = 0;
  return (overrideMessage?: string) => {
    attempts += 1;
    if (attempts >= MAX_PROMPT_ATTEMPTS) {
      throw new PromptAttemptsExceededError(promptKey, overrideMessage ?? message);
    }
  };
}

export type PromptFn = (question: string) => Promise<string>;
export type ProbeFn = (trackerId: string, env: Record<string, string>) => Promise<void>;
export type LogFn = (message: string) => void;

/** Prompt/probe/log dependencies for {@link validateConnection}. */
export interface ConnectionValidationIo {
  prompt: PromptFn;
  probe: ProbeFn;
  log: LogFn;
  /** Hidden-input prompt for {@link EnvPromptStep.secret} steps when values are edited. */
  promptSecret?: PromptFn;
}

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
  /** Show the default inline as `[value]` instead of an "Enter for default" hint. */
  defaultInBrackets?: boolean;
  /** Token or key: read with the hidden-input prompt when the wizard has one. */
  secret?: boolean;
}

/** Longest error message the wizards print on one line. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * One bounded line: an HTML error page body (some trackers return one for
 * 404/5xx) is dropped, whitespace collapsed, and the result truncated.
 */
export function condenseMessage(message: string): string {
  const html = message.search(/<(!doctype|html)\b/i);
  const text = (
    html >= 0 ? `${message.slice(0, html).replace(/[\s:-]+$/, "")} (HTML error page)` : message
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
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
      // /myself, not project search: Jira Cloud answers 200 with an empty list
      // to a bad token on the latter.
      await new JiraClient(
        env.JIRA_BASE_URL ?? "",
        env.JIRA_EMAIL ?? "",
        env.JIRA_API_TOKEN ?? "",
      ).verifyCredentials();
      return;
    case "linear":
      await new LinearClient({ apiKey: env.LINEAR_API_KEY ?? "" }).getTeams();
      return;
    case "github": {
      const [owner, repo] = (env.GITHUB_REPO || "/").split("/");
      const github = new GitHubClient({
        token: env.GITHUB_TOKEN ?? "",
        owner: owner ?? "",
        repo: repo ?? "",
      });
      // Check the repo itself when one is configured; otherwise only the token.
      if (env.GITHUB_REPO && owner && repo) await github.verifyRepoAccess();
      else await github.verifyToken();
      return;
    }
    case "gitlab":
      await new GitLabClient({
        token: env.GITLAB_TOKEN ?? "",
        projectPath: env.GITLAB_PROJECT ?? "",
        baseUrl: env.GITLAB_BASE_URL,
      }).getCurrentUser();
      return;
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
  /** Optional trailing note on the menu line (e.g. "no account needed"). */
  hint?: string;
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
    log(
      `   ${index + 1}. ${tracker.displayName} (${tracker.id})` +
        (tracker.hint ? ` — ${tracker.hint}` : ""),
    );
  });

  const reject = createPromptAttempts("TASK_TRACKER");
  for (;;) {
    const answer = (await prompt(`Enter a number (1-${trackerIds.length}) or tracker id: `)).trim();
    const byNumber = trackerIds[parseInt(answer, 10) - 1];
    if (byNumber && /^\d+$/.test(answer)) return byNumber;
    if (trackerIds.includes(answer.toLowerCase())) return answer.toLowerCase();
    log(
      `❌ Invalid choice: '${answer}'. Pick 1-${trackerIds.length} or one of: ${trackerIds.join(", ")}`,
    );
    reject(
      `No valid tracker choice after ${MAX_PROMPT_ATTEMPTS} attempts; enter 1-${trackerIds.length} or one of: ${trackerIds.join(", ")}`,
    );
  }
}

/**
 * Run a table of prompt steps, collecting answers into `values`.
 *
 * @param promptSecret - Hidden-input prompt for `secret` steps; without one
 *   they use `prompt`
 * @throws {@link PromptAttemptsExceededError} when a required step keeps
 *   getting empty answers, naming the step key
 */
export async function promptSteps(
  steps: EnvPromptStep[],
  prompt: PromptFn,
  log: LogFn,
  values: Record<string, string>,
  promptSecret?: PromptFn,
): Promise<void> {
  for (const step of steps) {
    const link = stepLink(step, values);
    if (link) {
      log(
        `\n🔗 Create your ${step.label.toLowerCase().replace(/\bgithub\b/g, "GitHub")} at:\n   ${link}`,
      );
    }
    const inlineDefault = step.defaultInBrackets ? step.defaultValue : undefined;
    const hints: string[] = [];
    const ask = step.secret && promptSecret ? promptSecret : prompt;
    if (step.secret && promptSecret) hints.push("input hidden");
    if (step.example && !inlineDefault) hints.push(`e.g. ${step.example}`);
    if (step.defaultValue && !inlineDefault) hints.push(`Enter for default`);
    else if (step.optional && !step.defaultValue) hints.push("optional, Enter to skip");
    const suffix = hints.length > 0 ? ` (${hints.join("; ")})` : "";
    const label = inlineDefault ? `${step.label} [${inlineDefault}]` : step.label;
    const reject = createPromptAttempts(step.key);

    for (;;) {
      const answer = (await ask(`${label}${suffix}: `)).trim();
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
      reject();
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
    promptSecret?: PromptFn;
  },
): Promise<boolean> {
  const { sourceLabel, trackerName, steps, prompt, log, values, promptSecret } = opts;
  log(`\n📋 Found an existing ${sourceLabel} for ${trackerName}.`);
  const answer = (await prompt("Reuse those credentials? (Y/n): ")).trim().toLowerCase();
  if (answer === "n" || answer === "no") return false;
  Object.assign(values, existing.values);
  const missing = steps.filter((step) => !step.optional && !values[step.key]);
  if (missing.length > 0) {
    await promptSteps(missing, prompt, log, values, promptSecret);
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
 * @throws {@link PromptAttemptsExceededError} when the "what next" answer stays
 *   unusable, instead of re-asking forever
 */
export async function validateConnection(
  trackerId: string,
  values: Record<string, string>,
  steps: EnvPromptStep[],
  io: ConnectionValidationIo,
  envPath: string,
): Promise<boolean> {
  const { prompt, probe, log, promptSecret } = io;
  let edits = 0;
  const reject = createPromptAttempts(trackerId);
  for (;;) {
    log("\n🔌 Checking the connection...");
    try {
      await withTimeout(probe(trackerId, values), PROBE_TIMEOUT_MS);
      log("✅ Connection verified.");
      return true;
    } catch (error) {
      log(
        `❌ Connection check failed: ${condenseMessage(error instanceof Error ? error.message : String(error))}`,
      );
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
        // What was entered (or defaulted) stays the Enter default, so fixing
        // one value does not mean retyping the rest.
        const editable = steps.map((step) =>
          values[step.key] ? { ...step, defaultValue: values[step.key] } : step,
        );
        await promptSteps(editable, prompt, log, values, promptSecret);
        continue;
      }
      if (answer === "r" || (answer === "e" && !canEdit)) {
        // retry with the current values
        continue;
      }
      reject(
        `No choice for the ${trackerId} connection check after ${MAX_PROMPT_ATTEMPTS} attempts; enter ${canEdit ? "r, e, or s" : "r or s"}`,
      );
    }
  }
}
