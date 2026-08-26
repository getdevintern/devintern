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

import { Utils } from "../utils";
import { loadWorkspaceConfig, parseWorkspaceConfig } from "./config";
import { parseEnvFile } from "./env";
import { resolveWorkspaceDir, workspaceConfigPath, workspaceEnvPath } from "./paths";

const CONFIG_TEMPLATE = `# DevIntern workspace: one worker drives every repo listed here.
# Docs: https://devintern.com/docs/code/workspaces

[workspace]
# Days before a leftover (failed-run) task worktree is swept.
worktrees_ttl_days = 7

[defaults]
# Tracker the fleet query runs against: jira, linear, github, azure-devops,
# asana, trello, or markdown.
tracker = "jira"
# Task-selection query in the tracker's query language.
# task_query = "sprint in openSprints() AND labels = devintern"
# Extra CLI flags per task run.
worker_task_args = "--create-pr"
default_branch = "main"

# Add repos with \`devintern workspace import\` (run inside each repo), or by
# hand:
#
# [[repos]]
# name = "backend"
# remote = "git@github.com:acme/backend.git"
# sync_team_prs = true       # also base-sync teammates' open PRs (needs AGENT_SANDBOX)
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
 * Scaffold the workspace config and shared env file.
 *
 * @returns Process exit code (0 on success).
 */
export function runWorkspaceInit(): number {
  const workspaceDir = resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  if (existsSync(configPath)) {
    console.error(`❌ ${configPath} already exists; refusing to overwrite.`);
    console.error("   Edit it directly, or run `devintern workspace import` inside a repo.");
    return 1;
  }

  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(configPath, CONFIG_TEMPLATE);
  const envPath = workspaceEnvPath(workspaceDir);
  if (!existsSync(envPath)) {
    writeFileSync(envPath, ENV_TEMPLATE);
  }

  console.log(`✅ Workspace created at ${workspaceDir}`);
  console.log(`   Config: ${configPath}`);
  console.log(`   Env:    ${envPath}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Put shared credentials in the workspace .env");
  console.log("  2. Run `devintern workspace import` inside each repo to migrate it");
  console.log("  3. Add [[routing.rules]] so tasks route to the right repo");
  console.log("  4. Start the fleet: devintern worker");
  return 0;
}

/**
 * Migrate the repo at `cwd` into the workspace.
 *
 * Idempotent: a repo already present (matched by remote URL) leaves the
 * config untouched; env merging still runs but only ever adds missing keys.
 *
 * @param cwd - Repository checkout to import.
 * @returns Process exit code (0 on success).
 */
export async function runWorkspaceImport(cwd: string): Promise<number> {
  const workspaceDir = resolveWorkspaceDir();
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) {
    console.error(
      `❌ No workspace found at ${configPath}. Run \`devintern workspace init\` first.`,
    );
    return 1;
  }

  const remoteResult = await Utils.executeGitCommand(["remote", "get-url", "origin"], { cwd });
  if (!remoteResult.success || !remoteResult.output.trim()) {
    console.error(
      "❌ Could not read the origin remote here. Run this inside a git repo with an origin.",
    );
    return 1;
  }
  const remote = remoteResult.output.trim();

  const existingText = readFileSync(configPath, "utf8");
  const config = parseWorkspaceConfig(existingText, configPath);

  if (config.repos.some((repo) => repo.remote === remote)) {
    console.log(`ℹ️  ${remote} is already in the workspace; config unchanged.`);
    mergeEnv(workspaceDir, cwd, {});
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
  const conflicts = mergeEnv(workspaceDir, cwd, {});

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
  // already claims that project.
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

  console.log(`✅ Imported ${remote} as "${name}"`);
  if (defaultBranch) {
    console.log(`   default_branch: ${defaultBranch}`);
  }
  if (Object.keys(conflicts).length > 0) {
    console.log(
      `   ${Object.keys(conflicts).length} env value(s) differed from the workspace .env and were kept in [repos.env]: ` +
        Object.keys(conflicts).join(", "),
    );
  }
  if (projectKey && !projectTaken) {
    console.log(`   Seeded routing rule: project = ${projectKey}`);
  } else {
    console.log("   Add a [[routing.rules]] entry so tasks route to this repo.");
  }
  console.log("   Note: .devintern-code/settings.json travels with the repo; nothing to migrate.");
  return 0;
}

function readRepoEnv(cwd: string): Record<string, string> {
  return parseEnvFile(join(cwd, ".devintern-code", ".env"));
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
    console.log(`   Merged ${additions.length} env key(s) into ${envPath}`);
  }

  return conflicts;
}
