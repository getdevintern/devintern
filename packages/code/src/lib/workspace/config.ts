import { readFileSync } from "fs";

import { supportsPolling, trackersSupportingPolling } from "../tracker-capabilities";
import { parseAutomationEntries } from "../automation-config";
import type { AutomationConfig } from "../automation-config";
import { parseToml } from "./toml";

/** Workspace-wide settings from the `[workspace]` table. */
export interface WorkspaceSettings {
  /** Days before a leftover (failed-run) task worktree is swept. */
  worktreesTtlDays: number;
  /**
   * Opt-in concurrency across repositories: when true, tasks routed to
   * different repos may run at the same time (bounded by
   * {@link WorkspaceSettings.maxConcurrency}). Execution within one repo
   * stays serialized. Defaults to false: the fleet runs one task at a time.
   */
  parallelAcrossRepos: boolean;
  /**
   * Global cap on concurrent fleet runs while parallel execution is enabled.
   * Positive integer; defaults to {@link DEFAULT_MAX_CONCURRENCY} when unset.
   * Ignored (and validated anyway) while `parallel_across_repos` is false.
   */
  maxConcurrency?: number;
  /** Serve the local observability dashboard from the worker process. */
  dashboard: boolean;
  /** Dashboard listen port; unset follows DASHBOARD_PORT / 4400. */
  dashboardPort?: number;
}

/** Fleet-wide defaults from the `[defaults]` table. */
export interface WorkspaceDefaults {
  /** Tracker driving the fleet query (must support polling). */
  tracker: string;
  /** Tracker query the worker polls with. */
  taskQuery?: string;
  /** Extra per-task CLI flags (default `--create-pr`). */
  workerTaskArgs?: string;
  /** Fallback default branch for repos that do not set one. */
  defaultBranch?: string;
  /** Seconds between tracker poll ticks. */
  pollIntervalSeconds: number;
}

/** One managed repository from a `[[repos]]` entry. */
export interface RepoConfig {
  /** Unique name; also the directory name under `repos/` and `worktrees/`. */
  name: string;
  /** Git remote URL the bare clone tracks. */
  remote: string;
  /** Default branch task worktrees start from; falls back to `defaults.default_branch`, then `origin/HEAD`. */
  defaultBranch?: string;
  /** Optional env file path, relative to the workspace directory. */
  envFile?: string;
  /** Inline env overrides (highest precedence). */
  env: Record<string, string>;
}

/** One routing rule from a `[[routing.rules]]` entry. Set criteria are AND-ed; list values match any-of. */
export interface RoutingRule {
  /** Name of the repo tasks matching this rule route to. */
  repo: string;
  /** Tracker project key (e.g. Jira key prefix, Linear team key). */
  project?: string;
  /** Task must carry at least one of these components. */
  components: string[];
  /** Task must carry at least one of these labels. */
  labels: string[];
}

/** Parsed and validated `workspace.toml`. */
export interface WorkspaceConfig {
  workspace: WorkspaceSettings;
  defaults: WorkspaceDefaults;
  repos: RepoConfig[];
  routing: RoutingRule[];
  automations: AutomationConfig[];
}

export const DEFAULT_WORKTREES_TTL_DAYS = 7;
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const DEFAULT_DASHBOARD = true;

/**
 * Safe default cap on concurrent fleet runs when
 * `[workspace].parallel_across_repos` is enabled without an explicit
 * `[workspace].max_concurrency`.
 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** Repo names double as directory names; keep them filesystem-safe. */
const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function asTable(value: unknown, label: string, errors: string[]): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be a table.`);
    return {};
  }
  return value as Record<string, unknown>;
}

function asTableArray(value: unknown, label: string, errors: string[]): Record<string, unknown>[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of tables.`);
    return [];
  }
  const tables: Record<string, unknown>[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label}[${index}] must be a table.`);
      continue;
    }
    tables.push(entry as Record<string, unknown>);
  }
  return tables;
}

function readString(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string | undefined {
  const value = table[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label}.${key} must be a non-empty string.`);
    return undefined;
  }
  return value.trim();
}

function readStringList(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string[] {
  const value = table[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push(`${label}.${key} must be an array of non-empty strings.`);
    return [];
  }
  return (value as string[]).map((item) => item.trim());
}

function readOptionalBoolean(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): boolean | undefined {
  const value = table[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    errors.push(`${label}.${key} must be a boolean.`);
    return undefined;
  }
  return value;
}

function readOptionalInteger(
  table: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
  bounds: { min: number; max?: number; message: string },
): number | undefined {
  const value = table[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min) {
    errors.push(bounds.message);
    return undefined;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    errors.push(bounds.message);
    return undefined;
  }
  return value;
}

function readEnvTable(
  table: Record<string, unknown>,
  label: string,
  errors: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(asTable(table.env, `${label}.env`, errors))) {
    if (typeof value !== "string") {
      errors.push(`${label}.env.${key} must be a string.`);
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Parse and validate workspace configuration from TOML text.
 *
 * Collects every problem and throws once, so a broken config is fixable
 * in a single pass.
 *
 * @param text - Raw `workspace.toml` content.
 * @param sourceLabel - Path or label used in error messages.
 * @returns Validated {@link WorkspaceConfig}.
 * @throws When the TOML is invalid or the config violates the schema.
 */
export function parseWorkspaceConfig(
  text: string,
  sourceLabel = "workspace.toml",
): WorkspaceConfig {
  let document: Record<string, unknown>;
  try {
    document = parseToml(text);
  } catch (error) {
    throw new Error(
      `Failed to parse ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const errors: string[] = [];

  const workspaceTable = asTable(document.workspace, "[workspace]", errors);
  const worktreesTtlDays =
    readOptionalInteger(workspaceTable, "worktrees_ttl_days", "[workspace]", errors, {
      min: 1,
      message: "[workspace].worktrees_ttl_days must be a positive integer.",
    }) ?? DEFAULT_WORKTREES_TTL_DAYS;
  const dashboard =
    readOptionalBoolean(workspaceTable, "dashboard", "[workspace]", errors) ?? DEFAULT_DASHBOARD;
  const dashboardPort = readOptionalInteger(
    workspaceTable,
    "dashboard_port",
    "[workspace]",
    errors,
    {
      min: 1,
      max: 65535,
      message: "[workspace].dashboard_port must be an integer between 1 and 65535.",
    },
  );

  const parallelValue = workspaceTable.parallel_across_repos;
  let parallelAcrossRepos = false;
  if (parallelValue !== undefined && parallelValue !== null) {
    if (typeof parallelValue !== "boolean") {
      errors.push("[workspace].parallel_across_repos must be a boolean (true or false).");
    } else {
      parallelAcrossRepos = parallelValue;
    }
  }

  let maxConcurrency: number | undefined;
  const concurrencyValue = workspaceTable.max_concurrency;
  if (concurrencyValue !== undefined && concurrencyValue !== null) {
    if (
      typeof concurrencyValue !== "number" ||
      !Number.isInteger(concurrencyValue) ||
      concurrencyValue < 1
    ) {
      errors.push(
        "[workspace].max_concurrency must be a positive integer (concurrent fleet runs).",
      );
    } else {
      maxConcurrency = concurrencyValue;
    }
  }

  const defaultsTable = asTable(document.defaults, "[defaults]", errors);
  const tracker = readString(defaultsTable, "tracker", "[defaults]", errors);
  if (tracker && !supportsPolling(tracker)) {
    errors.push(
      `[defaults].tracker "${tracker}" does not support polling. ` +
        `Pollable trackers: ${trackersSupportingPolling().join(", ")}.`,
    );
  }
  const defaults: WorkspaceDefaults = {
    tracker: tracker ?? "",
    taskQuery: readString(defaultsTable, "task_query", "[defaults]", errors),
    workerTaskArgs: readString(defaultsTable, "worker_task_args", "[defaults]", errors),
    defaultBranch: readString(defaultsTable, "default_branch", "[defaults]", errors),
    pollIntervalSeconds:
      readOptionalInteger(defaultsTable, "poll_interval", "[defaults]", errors, {
        min: 1,
        message: "[defaults].poll_interval must be a positive integer (seconds).",
      }) ?? DEFAULT_POLL_INTERVAL_SECONDS,
  };
  if (!tracker) {
    errors.push('[defaults].tracker is required (e.g. tracker = "jira").');
  }

  const repos: RepoConfig[] = [];
  const repoNames = new Set<string>();
  for (const [index, table] of asTableArray(document.repos, "[[repos]]", errors).entries()) {
    const label = `[[repos]][${index}]`;
    const name = readString(table, "name", label, errors);
    const remote = readString(table, "remote", label, errors);
    if (!name) {
      errors.push(`${label}.name is required.`);
    } else if (!REPO_NAME_PATTERN.test(name)) {
      errors.push(
        `${label}.name "${name}" must contain only letters, digits, ".", "_" or "-" and not start with a separator.`,
      );
    } else if (repoNames.has(name)) {
      errors.push(`Duplicate repo name "${name}". Repo names must be unique.`);
    } else {
      repoNames.add(name);
    }
    if (!remote) {
      errors.push(`${label}.remote is required (git URL).`);
    }
    if (!name || !remote) {
      continue;
    }
    repos.push({
      name,
      remote,
      defaultBranch: readString(table, "default_branch", label, errors) ?? defaults.defaultBranch,
      envFile: readString(table, "env_file", label, errors),
      env: readEnvTable(table, label, errors),
    });
  }

  const routingTable = asTable(document.routing, "[routing]", errors);
  const routing: RoutingRule[] = [];
  for (const [index, table] of asTableArray(
    routingTable.rules,
    "[[routing.rules]]",
    errors,
  ).entries()) {
    const label = `[[routing.rules]][${index}]`;
    const repo = readString(table, "repo", label, errors);
    if (!repo) {
      errors.push(`${label}.repo is required.`);
      continue;
    }
    if (!repoNames.has(repo)) {
      errors.push(`${label}.repo "${repo}" does not match any [[repos]] name.`);
    }
    const rule: RoutingRule = {
      repo,
      project: readString(table, "project", label, errors),
      components: readStringList(table, "components", label, errors),
      labels: readStringList(table, "labels", label, errors),
    };
    if (!rule.project && rule.components.length === 0 && rule.labels.length === 0) {
      errors.push(`${label} must set at least one criterion (project, components, or labels).`);
    }
    routing.push(rule);
  }

  const automationResult = parseAutomationEntries(document.automations, {
    sourceLabel,
    repoNames,
  });
  errors.push(...automationResult.errors);

  if (errors.length > 0) {
    throw new Error(`Invalid ${sourceLabel}:\n- ${errors.join("\n- ")}`);
  }

  return {
    workspace: { worktreesTtlDays, parallelAcrossRepos, maxConcurrency, dashboard, dashboardPort },
    defaults,
    repos,
    routing,
    automations: automationResult.automations,
  };
}

/**
 * Effective global concurrency limit for a workspace.
 *
 * Serial mode (`parallel_across_repos` omitted or false) always yields 1.
 * Parallel mode yields the configured cap (or
 * {@link DEFAULT_MAX_CONCURRENCY}); a cap larger than the fleet is valid —
 * per-repo serialization naturally bounds actual concurrency.
 *
 * @param config - Validated {@link WorkspaceConfig}
 */
export function effectiveMaxConcurrency(config: WorkspaceConfig): number {
  if (!config.workspace.parallelAcrossRepos) {
    return 1;
  }
  return Math.max(1, config.workspace.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
}

/**
 * Load and validate a `workspace.toml` from disk.
 *
 * @param path - Absolute path of the workspace config file.
 * @returns Validated {@link WorkspaceConfig}.
 * @throws When the file is missing, unreadable, or invalid.
 */
export function loadWorkspaceConfig(path: string): WorkspaceConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read workspace config at ${path}: ${error instanceof Error ? error.message : String(error)}\n` +
        "Run `devintern workspace init` to create one.",
    );
  }
  return parseWorkspaceConfig(text, path);
}

/**
 * Look up a repo by name.
 *
 * @returns The matching {@link RepoConfig}, or undefined.
 */
export function findRepo(config: WorkspaceConfig, name: string): RepoConfig | undefined {
  return config.repos.find((repo) => repo.name === name);
}
