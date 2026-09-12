/** Shared interactive Sentry setup for worker init and worker connect. */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { parseEnvContent } from "@devintern/task-trackers";

import { DEFAULT_SENTRY_BASE_URL, SentryClient } from "./observability/sentry-client";
import { loadWorkspaceConfig } from "./workspace/config";
import { writeSentryErrorMonitor } from "./workspace/init";
import { workspaceConfigPath, workspaceEnvPath } from "./workspace/paths";

export type SentrySetupPromptFn = (question: string) => Promise<string>;
export type SentrySetupLogFn = (message: string) => void;

export interface SentryValidationOptions {
  authToken: string;
  organization: string;
  project: string;
  baseUrl: string;
  query?: string;
}

export interface WorkerSentrySetupOptions {
  workspaceDir: string;
  repoName?: string;
  prompt?: SentrySetupPromptFn;
  log?: SentrySetupLogFn;
  validateSentry?: (options: SentryValidationOptions) => Promise<number>;
}

export interface WorkerSentrySetupResult {
  ok: boolean;
  added?: boolean;
  id?: string;
}

async function defaultValidateSentry(options: SentryValidationOptions): Promise<number> {
  const issues = await new SentryClient(options).fetchUnresolvedIssues();
  return issues.length;
}

/** Validate and add one Sentry error monitor to an existing workspace. */
export async function runWorkerSentrySetup(
  options: WorkerSentrySetupOptions,
): Promise<WorkerSentrySetupResult> {
  const log = options.log ?? console.log;
  let rl: import("node:readline/promises").Interface | undefined;
  let prompt = options.prompt;
  if (!prompt) {
    const { createInterface } = await import("node:readline/promises");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    prompt = (question: string) => rl!.question(question);
  }

  try {
    const config = loadWorkspaceConfig(workspaceConfigPath(options.workspaceDir));
    let repoName = options.repoName;
    if (repoName && !config.repos.some((repo) => repo.name === repoName)) {
      log(`⚠️  Sentry setup skipped: workspace repository "${repoName}" does not exist.`);
      return { ok: false };
    }
    if (!repoName && config.repos.length === 1) repoName = config.repos[0]?.name;
    if (!repoName) {
      log(`   Workspace repositories: ${config.repos.map((repo) => repo.name).join(", ")}`);
      repoName = (await prompt("Repository for this Sentry project: ")).trim();
      if (!config.repos.some((repo) => repo.name === repoName)) {
        log(`⚠️  Sentry setup skipped: workspace repository "${repoName}" does not exist.`);
        return { ok: false };
      }
    }

    const baseUrl =
      (await prompt(`Sentry URL [${DEFAULT_SENTRY_BASE_URL}]: `)).trim() || DEFAULT_SENTRY_BASE_URL;
    const organization = (await prompt("Sentry organization slug: ")).trim();
    const project = (await prompt("Sentry project slug: ")).trim();
    const sentryQuery = (
      await prompt("Sentry search filter (optional, e.g. environment:production): ")
    ).trim();

    if (!organization || !project) {
      log("⚠️  Sentry setup skipped: organization and project slugs are required.");
      return { ok: false };
    }

    const envPath = workspaceEnvPath(options.workspaceDir);
    const workspaceEnv = parseEnvContent(existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
    const existingToken = process.env.SENTRY_AUTH_TOKEN || workspaceEnv.SENTRY_AUTH_TOKEN;
    if (existingToken) log("   Using SENTRY_AUTH_TOKEN from the existing environment.");
    log(
      "   Create a token with event:write access: https://sentry.io/settings/account/api/auth-tokens/",
    );
    const authToken =
      existingToken || (await prompt("Sentry auth token (input is visible): ")).trim();
    if (!authToken) {
      log("⚠️  Sentry setup skipped: an auth token is required.");
      return { ok: false };
    }

    try {
      const issueCount = await (options.validateSentry ?? defaultValidateSentry)({
        authToken,
        organization,
        project,
        baseUrl,
        query: sentryQuery || undefined,
      });
      log(`✅ Sentry access works: ${issueCount} unresolved issue(s) currently match.`);

      const monitor = writeSentryErrorMonitor(options.workspaceDir, {
        authToken,
        organization,
        project,
        repo: repoName,
        baseUrl,
        query: sentryQuery || undefined,
      });
      if (monitor.added) {
        log(`💾 Added [[error_monitors]] "${monitor.id}" to workspace.toml.`);
        log(`🔐 Stored its token in ${join(options.workspaceDir, monitor.envFile)} (mode 0600).`);
      } else {
        log(`   Sentry monitor "${monitor.id}" is already configured; no duplicate added.`);
      }
      return { ok: true, added: monitor.added, id: monitor.id };
    } catch (error) {
      log(`⚠️  Sentry setup skipped: ${(error as Error).message}`);
      log("   No monitor or credential file was written.");
      return { ok: false };
    }
  } finally {
    rl?.close();
  }
}
