/**
 * Non-interactive `devintern worker connect sentry`: the same validation and
 * `[[error_monitors]]` / env-file writes as the interactive flow, driven by
 * flags and an auth token from the environment or a 0600 `--env-file`.
 */

import { resolve } from "path";

import { DEFAULT_SENTRY_BASE_URL } from "../observability/sentry-client";
import { loadWorkspaceConfig } from "../workspace/config";
import {
  findSentryErrorMonitor,
  refreshSentryMonitorToken,
  writeSentryErrorMonitor,
} from "../workspace/init";
import { workspaceConfigPath } from "../workspace/paths";
import { readEnvFile } from "./worker-init-noninteractive-plan";
import { defaultValidateSentry } from "./worker-sentry-setup";
import type { SentryValidationOptions } from "./worker-sentry-setup";

/** Flags that select the non-interactive Sentry flow. */
export interface SentryConnectFlags {
  organization?: string;
  /** One or more project slugs (repeated flag or comma-separated). */
  projects: string[];
  baseUrl?: string;
  query?: string;
  /** Path to a 0600 file holding `SENTRY_AUTH_TOKEN`. */
  envFile?: string;
  /** Update monitors that already exist. */
  yes: boolean;
}

export interface SentryMonitorReport {
  id: string;
  organization: string;
  project: string;
  repo: string;
  baseUrl: string;
  /** Workspace-relative file holding the monitor's token, when it has one. */
  envFile?: string;
  action: "added" | "updated" | "unchanged";
  unresolvedIssues: number;
}

export type SentryNonInteractiveResult =
  | { ok: true; monitors: SentryMonitorReport[]; warnings: string[] }
  | {
      ok: false;
      code:
        | "missing_flags"
        | "missing_token"
        | "env_file_unreadable"
        | "invalid_sentry_url"
        | "repo_required"
        | "unknown_repo"
        | "monitor_exists"
        | "sentry_validation_failed"
        | "write_failed";
      error: string;
      /** Flags or variables that were not supplied. */
      missing?: string[];
    };

export interface SentryNonInteractiveOptions {
  workspaceDir: string;
  repoName?: string;
  flags: SentryConnectFlags;
  /** Base for a relative `--env-file`. */
  cwd: string;
  /** Credential environment (workspace `.env` already layered under the process env). */
  env: Record<string, string | undefined>;
  validateSentry?: (options: SentryValidationOptions) => Promise<number>;
}

/** Split `--project` values on commas and drop blanks and duplicates. */
export function splitProjectSlugs(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function resolveToken(
  options: SentryNonInteractiveOptions,
): { token: string } | Extract<SentryNonInteractiveResult, { ok: false }> {
  const { envFile } = options.flags;
  if (envFile) {
    const read = readEnvFile(resolve(options.cwd, envFile));
    if (!read.ok) return { ok: false, code: "env_file_unreadable", error: read.error };
    const token = read.values.SENTRY_AUTH_TOKEN?.trim();
    if (!token) {
      return {
        ok: false,
        code: "missing_token",
        error: `--env-file ${envFile} does not define SENTRY_AUTH_TOKEN.`,
        missing: ["SENTRY_AUTH_TOKEN"],
      };
    }
    return { token };
  }
  const token = options.env.SENTRY_AUTH_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      code: "missing_token",
      error:
        "SENTRY_AUTH_TOKEN is not set. Put it in the environment or in a file passed with " +
        "--env-file <path> (mode 0600); it is never accepted as a flag.",
      missing: ["SENTRY_AUTH_TOKEN"],
    };
  }
  return { token };
}

function resolveRepo(
  repoNames: string[],
  requested: string | undefined,
): { repo: string } | Extract<SentryNonInteractiveResult, { ok: false }> {
  if (requested && !repoNames.includes(requested)) {
    return {
      ok: false,
      code: "unknown_repo",
      error: `Workspace repository "${requested}" does not exist. Repositories: ${repoNames.join(", ")}.`,
    };
  }
  const repo = requested ?? (repoNames.length === 1 ? repoNames[0] : undefined);
  if (!repo) {
    return {
      ok: false,
      code: "repo_required",
      error: `Several repositories are configured; pass --repo <name> (${repoNames.join(", ")}).`,
      missing: ["--repo"],
    };
  }
  return { repo };
}

/**
 * Validate and add (or, with `--yes`, refresh) Sentry error monitors without
 * prompting. Nothing is written unless every project validates.
 */
export async function runNonInteractiveSentrySetup(
  options: SentryNonInteractiveOptions,
): Promise<SentryNonInteractiveResult> {
  const { flags } = options;
  const missing = [
    ...(flags.organization ? [] : ["--org"]),
    ...(flags.projects.length > 0 ? [] : ["--project"]),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_flags",
      error: `Missing ${missing.join(" and ")}: the non-interactive Sentry setup needs the organization and project slugs.`,
      missing,
    };
  }
  const organization = flags.organization!;
  const baseUrl = (flags.baseUrl?.trim() || DEFAULT_SENTRY_BASE_URL).replace(/\/+$/, "");
  if (!isHttpUrl(baseUrl)) {
    return {
      ok: false,
      code: "invalid_sentry_url",
      error: `--sentry-url must be an http(s) URL, for example https://de.sentry.io (got "${baseUrl}").`,
    };
  }

  let config;
  try {
    config = loadWorkspaceConfig(workspaceConfigPath(options.workspaceDir));
  } catch (error) {
    return { ok: false, code: "write_failed", error: (error as Error).message };
  }
  const repoChoice = resolveRepo(
    config.repos.map((repo) => repo.name),
    options.repoName,
  );
  if ("ok" in repoChoice) return repoChoice;
  const { repo } = repoChoice;

  const resolved = resolveToken(options);
  if (!("token" in resolved)) return resolved;
  const { token } = resolved;
  const redact = (text: string): string => text.split(token).join("***");

  const existingByProject = new Map(
    flags.projects.map((project) => [
      project,
      findSentryErrorMonitor(config, { organization, project, repo, baseUrl }),
    ]),
  );
  const existing = flags.projects.filter((project) => existingByProject.get(project));
  if (existing.length > 0 && !flags.yes) {
    return {
      ok: false,
      code: "monitor_exists",
      error:
        `A Sentry monitor already exists for ${existing.join(", ")}. ` +
        "Pass --yes to refresh its stored token.",
    };
  }

  const validate = options.validateSentry ?? defaultValidateSentry;
  const counts = new Map<string, number>();
  for (const project of flags.projects) {
    try {
      counts.set(
        project,
        await validate({
          authToken: token,
          organization,
          project,
          baseUrl,
          query: flags.query || undefined,
        }),
      );
    } catch (error) {
      return {
        ok: false,
        code: "sentry_validation_failed",
        error: `Sentry rejected ${organization}/${project}: ${redact((error as Error).message)}. Nothing was written.`,
      };
    }
  }

  const monitors: SentryMonitorReport[] = [];
  const warnings: string[] = [];
  try {
    for (const project of flags.projects) {
      const found = existingByProject.get(project);
      const unresolvedIssues = counts.get(project) ?? 0;
      if (found) {
        const envFile = refreshSentryMonitorToken(options.workspaceDir, found, token);
        if (!envFile) {
          warnings.push(
            `Monitor "${found.id}" has no env_file; its token was not changed. Set SENTRY_AUTH_TOKEN where that monitor reads credentials.`,
          );
        }
        if (flags.query && flags.query !== found.query) {
          warnings.push(
            `Monitor "${found.id}" keeps its existing query; edit [[error_monitors]] in workspace.toml to change it.`,
          );
        }
        monitors.push({
          id: found.id,
          organization,
          project,
          repo,
          baseUrl,
          envFile: envFile ?? undefined,
          action: envFile ? "updated" : "unchanged",
          unresolvedIssues,
        });
        continue;
      }
      const written = writeSentryErrorMonitor(options.workspaceDir, {
        authToken: token,
        organization,
        project,
        repo,
        baseUrl,
        query: flags.query || undefined,
      });
      monitors.push({
        id: written.id,
        organization,
        project,
        repo,
        baseUrl,
        envFile: written.envFile,
        action: written.added ? "added" : "unchanged",
        unresolvedIssues,
      });
    }
  } catch (error) {
    return { ok: false, code: "write_failed", error: redact((error as Error).message) };
  }
  return { ok: true, monitors, warnings };
}
