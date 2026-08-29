/**
 * `devintern workspace init` / `devintern workspace import`.
 *
 * `init` scaffolds a commented `~/.devintern/workspace.toml` plus a shared
 * `.env`. `import` runs inside an existing single-repo checkout and migrates
 * it into the workspace: origin remote becomes a `[[repos]]` entry, the
 * repo's `.devintern-code/.env` keys merge into the workspace `.env`, and
 * conflicting values are demoted to that repo's inline `[repos.env]` instead
 * of silently overwriting anything (never guess). New entries are appended
 * as text, so hand-written comments in the existing config survive.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

import { findProjectRoot } from "@devintern/utils";

import { Utils } from "../utils";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "./config";
import { parseEnvFile } from "./env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "./paths";

const CONFIG_TEMPLATE = `# DevIntern workspace: one worker drives every repo listed here.
# Docs: https://devintern.com/docs/code/workspaces

[workspace]
# Days before a leftover (failed-run) task worktree is swept.
worktrees_ttl_days = 7
# Local observability dashboard (http://localhost:4400). Set false to disable.
dashboard = true
# dashboard_port = 4400
# When automatic merge-conflict resolution runs on the agent's PRs.
# "auto" (default) resolves as soon as a conflict is detected; "scheduled"
# queues conflicts during polling and resolves them in one off-peak window
# to cut AI token spend. Requires exactly one schedule below, and a worker
# restart to take effect. "disabled" turns it off entirely — conflicts
# stay for manual resolution (devintern resolve-conflicts <pr-url>).
# conflict_resolution = "scheduled"
# conflict_resolution_cron = "0 3 * * *"      # worker host timezone
# conflict_resolution_interval = "1d"

[defaults]
# Tracker the fleet query runs against: jira, linear, github, azure-devops,
# asana, trello, or markdown.
tracker = "jira"
# Task-selection query in the tracker's query language.
# task_query = "sprint in openSprints() AND labels = devintern"
# Extra CLI flags per task run.
worker_task_args = "--create-pr"
# Labels applied to created PRs (GitHub only). Override per repo.
# pr_labels = ["devintern", "auto-pr"]
# Seconds between tracker polls.
poll_interval = 60
default_branch = "main"

# Add repos with \`devintern workspace import\` (run inside each repo), or by
# hand:
#
# [[repos]]
# name = "backend"
# remote = "git@github.com:acme/backend.git"
#
# [[routing.rules]]
# repo = "backend"
# project = "BACK"            # task key prefix (BACK-123)
# labels = ["backend"]        # any-of; AND-ed with the other criteria

# Recurring work is loaded once when the worker starts. Each occurrence runs
# the prompt through the normal task pipeline as a local markdown task.
# Cron uses the worker host timezone; interval values support m, h, and d.
#
# [[automations]]
# id = "weekday-maintenance"
# enabled = true
# cron = "0 9 * * 1-5"       # exactly one of cron / interval
# prompt = "Inspect dependency health and fix one safe issue."
# repo = "backend"            # required in a multi-repo workspace
`;

const ENV_TEMPLATE = `# Shared workspace environment: tracker credentials, GITHUB_TOKEN and/or
# GitHub App (GITHUB_APP_ID + private key), agent settings.
# Per-repo overrides go in [repos.env] in workspace.toml.
`;

/** Values that should never migrate into the shared workspace env. */
const ENV_IMPORT_SKIP = new Set(["WEBHOOK_QUEUE_DB"]);

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Insert or update `[defaults].tracker` / `[defaults].task_query` in a
 * workspace.toml document without rewriting unrelated comments or tables.
 *
 * @param content - Current workspace.toml text
 * @param defaults - Fields to write
 */
export function upsertWorkspaceDefaults(
  content: string,
  defaults: { tracker?: string; taskQuery?: string },
): string {
  let next = content.endsWith("\n") ? content : `${content}\n`;

  if (!/^\[defaults\]/m.test(next) && (defaults.tracker || defaults.taskQuery !== undefined)) {
    next += "\n[defaults]\n";
  }

  const sectionStart = next.search(/^\[defaults\]\s*$/m);
  if (sectionStart === -1) return next;
  const contentStart = next.indexOf("\n", sectionStart) + 1;
  const remaining = next.slice(contentStart);
  const nextTableOffset = remaining.search(/^\s*\[(?!defaults\])[^\n]*$/m);
  const sectionEnd = nextTableOffset === -1 ? next.length : contentStart + nextTableOffset;
  let section = next.slice(contentStart, sectionEnd);

  const upsert = (key: string, value: string, allowCommented: boolean): void => {
    const prefix = allowCommented ? "#?\\s*" : "";
    const pattern = new RegExp(`^\\s*${prefix}${key}\\s*=\\s*.*$`, "m");
    const line = `${key} = ${tomlString(value)}`;
    if (pattern.test(section)) {
      section = section.replace(pattern, line);
      return;
    }
    const separator = section.length > 0 && !section.endsWith("\n") ? "\n" : "";
    section += `${separator}${line}\n`;
  };

  if (defaults.tracker) upsert("tracker", defaults.tracker, false);
  if (defaults.taskQuery !== undefined) upsert("task_query", defaults.taskQuery, true);

  next = next.slice(0, contentStart) + section + next.slice(sectionEnd);

  return next;
}

/** Validate and persist `[defaults]` updates to `workspace.toml`. */
export function writeWorkspaceDefaults(
  workspaceDir: string,
  defaults: { tracker?: string; taskQuery?: string },
): void {
  const configPath = workspaceConfigPath(workspaceDir);
  const updated = upsertWorkspaceDefaults(readFileSync(configPath, "utf8"), defaults);
  parseWorkspaceConfig(updated, configPath);
  writeFileSync(configPath, updated);
}

export type WorkspaceLogFn = (message: string) => void;

/**
 * Create `workspace.toml` + `.env` when missing. Does not refuse an existing
 * workspace (unlike the CLI `workspace init`).
 */
export function ensureWorkspaceScaffold(log: WorkspaceLogFn = console.log): {
  workspaceDir: string;
  configPath: string;
  created: boolean;
} {
  const workspaceDir = resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  if (existsSync(configPath)) {
    return { workspaceDir, configPath, created: false };
  }

  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(configPath, CONFIG_TEMPLATE);
  const envPath = workspaceEnvPath(workspaceDir);
  if (!existsSync(envPath)) {
    writeFileSync(envPath, ENV_TEMPLATE);
  }

  log(`✅ Workspace created at ${workspaceDir}`);
  log(`   Config: ${configPath}`);
  log(`   Env:    ${envPath}`);
  return { workspaceDir, configPath, created: true };
}

/**
 * Scaffold the workspace config and shared env file.
 *
 * @returns Process exit code (0 on success).
 */
export function runWorkspaceInit(): number {
  const { created, configPath } = ensureWorkspaceScaffold();
  if (!created) {
    console.error(`❌ ${configPath} already exists; refusing to overwrite.`);
    console.error("   Edit it directly, or run `devintern workspace import` inside a repo.");
    return 1;
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Put shared credentials in the workspace .env");
  console.log("  2. Run `devintern workspace import` inside each repo to migrate it");
  console.log("  3. Add [[routing.rules]] so tasks route to the right repo");
  console.log("  4. Start the fleet: devintern worker");
  return 0;
}

export interface WorkspaceImportOptions {
  log?: WorkspaceLogFn;
  error?: WorkspaceLogFn;
}

/**
 * Migrate the repo at `cwd` into the workspace.
 *
 * Idempotent: a repo already present (matched by remote URL) leaves the
 * config untouched; env merging still runs but only ever adds missing keys.
 *
 * @param cwd - Repository checkout to import.
 * @param options - Optional log/error sinks (defaults to console).
 * @returns Process exit code (0 on success).
 */
export async function runWorkspaceImport(
  cwd: string,
  options: WorkspaceImportOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const workspaceDir = resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) {
    error(`❌ No workspace found at ${configPath}. Run \`devintern workspace init\` first.`);
    return 1;
  }

  const remoteResult = await Utils.executeGitCommand(["remote", "get-url", "origin"], { cwd });
  if (!remoteResult.success || !remoteResult.output.trim()) {
    error("❌ Could not read the origin remote here. Run this inside a git repo with an origin.");
    return 1;
  }
  const remote = remoteResult.output.trim();

  const existingText = readFileSync(configPath, "utf8");
  const config = parseWorkspaceConfig(existingText, configPath);
  const isFirstRepo = config.repos.length === 0;

  if (config.repos.some((repo) => repo.remote === remote)) {
    log(`ℹ️  ${remote} is already in the workspace; config unchanged.`);
    mergeEnv(workspaceDir, cwd, {}, log);
    return 0;
  }

  // Derive a unique, filesystem-safe name from the remote.
  const rawName = basename(remote.replace(/\.git\/?$/, "")).replace(/[^A-Za-z0-9._-]+/g, "-");
  let name = rawName || "repo";
  let suffix = 2;
  const taken = new Set(config.repos.map((repo) => repo.name));
  while (taken.has(name)) {
    name = `${rawName}-${suffix++}`;
  }

  // Default branch from origin/HEAD when it differs from the workspace default.
  let defaultBranch: string | undefined;
  const head = await Utils.executeGitCommand(
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    { cwd },
  );
  if (head.success && head.output.trim()) {
    const branch = head.output.trim().replace(/^origin\//, "");
    if (branch !== (config.defaults.defaultBranch ?? "")) {
      defaultBranch = branch;
    }
  }

  // Merge the repo's env: missing keys go to the shared .env; conflicting
  // values are demoted to this repo's inline [repos.env].
  const conflicts = mergeEnv(workspaceDir, cwd, {}, log);

  let block = `\n[[repos]]\nname = ${tomlString(name)}\nremote = ${tomlString(remote)}\n`;
  if (defaultBranch) {
    block += `default_branch = ${tomlString(defaultBranch)}\n`;
  }
  if (Object.keys(conflicts).length > 0) {
    block += "  [repos.env]\n";
    for (const [key, value] of Object.entries(conflicts)) {
      block += `  ${key} = ${tomlString(value)}\n`;
    }
  }

  // Seed a routing rule from the repo's default project key, unless a rule
  // already claims that project. A 1-repo workspace needs no rule.
  const repoEnv = readRepoEnv(cwd);
  const projectKey = repoEnv.JIRA_DEFAULT_PROJECT_KEY || repoEnv.LINEAR_DEFAULT_TEAM_KEY;
  const projectTaken = config.routing.some(
    (rule) => rule.project && projectKey && rule.project.toLowerCase() === projectKey.toLowerCase(),
  );
  if (projectKey && !projectTaken) {
    block += `\n[[routing.rules]]\nrepo = ${tomlString(name)}\nproject = ${tomlString(projectKey)}\n`;
  }

  const updated = existingText.endsWith("\n") ? existingText + block : existingText + "\n" + block;

  // Validate the result before committing it to disk.
  parseWorkspaceConfig(updated, configPath);
  writeFileSync(configPath, updated);
  loadWorkspaceConfig(configPath);

  log(`✅ Imported ${remote} as "${name}"`);
  if (defaultBranch) {
    log(`   default_branch: ${defaultBranch}`);
  }
  if (Object.keys(conflicts).length > 0) {
    log(
      `   ${Object.keys(conflicts).length} env value(s) differed from the workspace .env and were kept in [repos.env]: ` +
        Object.keys(conflicts).join(", "),
    );
  }
  if (projectKey && !projectTaken) {
    log(`   Seeded routing rule: project = ${projectKey}`);
  } else if (isFirstRepo) {
    log(
      "   1-repo workspace: every ready task runs here. Add routing rules when you import another repo.",
    );
  } else {
    log("   Add a [[routing.rules]] entry so tasks route to this repo.");
  }
  log("   Note: .devintern-code/settings.json travels with the repo; nothing to migrate.");
  return 0;
}

/**
 * Create the workspace if needed and import `cwd` into it.
 *
 * @param cwd - Repository checkout to import
 * @param log - Status messages
 * @param error - Failure messages
 */
export async function ensureWorkspaceAndImport(
  cwd: string,
  log: WorkspaceLogFn = console.log,
  error: WorkspaceLogFn = console.error,
): Promise<{ ok: true; workspaceDir: string; created: boolean } | { ok: false; error: string }> {
  const { workspaceDir, created } = ensureWorkspaceScaffold(log);
  if (!created) {
    log(`ℹ️  Using existing workspace at ${workspaceDir}`);
    const remoteResult = await Utils.executeGitCommand(["remote", "get-url", "origin"], { cwd });
    if (!remoteResult.success || !remoteResult.output.trim()) {
      return { ok: false, error: "Could not read this repo's origin remote." };
    }
    const config = loadWorkspaceConfig(workspaceConfigPath(workspaceDir));
    if (!config.repos.some((repo) => repo.remote === remoteResult.output.trim())) {
      return {
        ok: false,
        error:
          "A workspace already exists and does not contain this repo. " +
          "Use `devintern workspace import` to add it without replacing workspace defaults.",
      };
    }
  }
  const code = await runWorkspaceImport(cwd, { log, error });
  if (code !== 0) {
    return { ok: false, error: "Could not import this repo into the workspace." };
  }
  return { ok: true, workspaceDir, created };
}

function readRepoEnv(cwd: string): Record<string, string> {
  // Same traversal as tracker setup: `worker init` / `workspace import` from a
  // package subdirectory must still find the repo-root `.devintern-code/.env`.
  const projectRoot = findProjectRoot({ startDir: cwd });
  return parseEnvFile(join(projectRoot, ".devintern-code", ".env"));
}

/**
 * Merge the repo's `.devintern-code/.env` into the workspace `.env`.
 *
 * Missing keys are appended; identical values are skipped; differing values
 * are returned as conflicts for the caller to keep repo-local.
 */
function mergeEnv(
  workspaceDir: string,
  cwd: string,
  conflicts: Record<string, string>,
  log: WorkspaceLogFn,
): Record<string, string> {
  const repoEnv = readRepoEnv(cwd);
  const envPath = workspaceEnvPath(workspaceDir);
  const workspaceEnv = parseEnvFile(envPath);

  const additions: string[] = [];
  for (const [key, value] of Object.entries(repoEnv)) {
    if (ENV_IMPORT_SKIP.has(key)) {
      continue;
    }
    if (!(key in workspaceEnv)) {
      additions.push(`${key}=${value}`);
    } else if (workspaceEnv[key] !== value) {
      conflicts[key] = value;
    }
  }

  if (additions.length > 0) {
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(envPath, existing + separator + additions.join("\n") + "\n");
    log(`   Merged ${additions.length} env key(s) into ${envPath}`);
  }

  return conflicts;
}
