/**
 * Initialize .devintern-pm configuration in the current directory
 */

import { join } from "node:path";
import {
  REPO_SCOPED_ENV_KEYS,
  parseEnvContent,
  resolveWorkspaceEnvPath,
  resolveWorkspaceTracker,
} from "@devintern/task-trackers";
import { PM_TRACKER_SETUP } from "./init-shared";
import { readFile, writeFile, pathExists, mkdir } from "./runtime/fs.js";
import { getModuleDir } from "./runtime/path.js";
import { askConfirm } from "./runtime/stdin.js";

/**
 * Initialize `.devintern-pm` configuration in the current directory.
 *
 * Creates `.devintern-pm/.env` from `.env.example`, migrates values from `.devintern-code`
 * when present, and updates `.gitignore` to exclude secret files.
 *
 * @returns Resolves when initialization completes; may exit the process if the user cancels overwrite.
 */
export async function initializeProject(): Promise<void> {
  const cwd = process.cwd();
  const devinternPmDir = join(cwd, ".devintern-pm");
  const envPath = join(devinternPmDir, ".env");

  console.log("🚀 Initializing @devintern/pm in current directory...\n");

  // Check if .devintern-pm already exists
  try {
    const stat = await pathExists(devinternPmDir);
    if (stat) {
      console.log("⚠️  .devintern-pm directory already exists");
      const shouldOverwrite = await askConfirm("Overwrite existing configuration?");
      if (!shouldOverwrite) {
        console.log("❌ Initialization cancelled");
        process.exit(0);
      }
    }
  } catch {
    // Directory doesn't exist, continue
  }

  // Create .devintern-pm directory
  await mkdir(devinternPmDir);
  console.log("✅ Created .devintern-pm directory");

  // Copy .env.example from the script's directory
  const scriptDir = getModuleDir(import.meta.url);
  const projectRoot = join(scriptDir, "..");
  const envExamplePath = join(projectRoot, ".env.example");
  const envExampleContent = await readFile(envExamplePath);

  const migrated = await readDevinternCodeConfig(cwd);

  // Replace values in .env.example with migrated values if available
  const envContent = applyMigratedConfig(envExampleContent, migrated);

  // Write .env file
  await writeFile(envPath, envContent);
  console.log("✅ Created .env configuration file");

  await ensureGitignore(cwd);

  console.log("\n✨ Initialization complete!");
  console.log(`\nNext steps:`);
  console.log(`1. Edit .devintern-pm/.env with your configuration`);
  console.log(`2. Run devpm --interactive to create your first task`);
}

interface MigratedPmConfig {
  trackerId?: string;
  values: Record<string, string>;
  agentHarness: string;
  agentCliPath: string;
}

function emptyMigratedConfig(): MigratedPmConfig {
  return { values: {}, agentHarness: "", agentCliPath: "" };
}

const TRACKER_STEP_KEYS = new Set(
  Object.values(PM_TRACKER_SETUP).flatMap((steps) => steps.map((step) => step.key)),
);

/**
 * Read tracker and agent values from the project's `.devintern-code/.env`,
 * falling back to the DevIntern workspace `.env` for keys the project file
 * does not provide. The workspace `[defaults].tracker` in `workspace.toml` is
 * canonical for the workspace layer, so a stale `TASK_TRACKER` in the shared
 * `.env` cannot re-route the scaffold; it is also the fallback when neither
 * file selects a tracker.
 *
 * Workspace values are filtered to credentials: repo-scoped keys (project
 * key, repo, board, directory) always belong to the current project and are
 * never inherited from another repo. The workspace file is never written to.
 *
 * @param cwd - Project directory to look in.
 * @returns Migrated values; empty when no config is found.
 */
async function readDevinternCodeConfig(cwd: string): Promise<MigratedPmConfig> {
  const config = emptyMigratedConfig();
  const workspaceTracker = await resolveWorkspaceTracker(undefined, { projectDir: cwd });
  const sources = [
    { label: ".devintern-code", path: join(cwd, ".devintern-code", ".env"), workspace: false },
    { label: "DevIntern workspace", path: resolveWorkspaceEnvPath(), workspace: true },
  ];

  for (const source of sources) {
    try {
      if (!(await pathExists(source.path))) continue;

      console.log(`📋 Found existing ${source.label} configuration`);
      const parsed = parseMigratedConfig(await readFile(source.path));
      if (source.workspace) {
        for (const key of Object.keys(parsed.values)) {
          if (REPO_SCOPED_ENV_KEYS.has(key)) delete parsed.values[key];
        }
        if (workspaceTracker) parsed.trackerId = workspaceTracker;
      }

      if (!config.trackerId && parsed.trackerId) config.trackerId = parsed.trackerId;
      if (!config.agentHarness && parsed.agentHarness) config.agentHarness = parsed.agentHarness;
      if (!config.agentCliPath && parsed.agentCliPath) config.agentCliPath = parsed.agentCliPath;
      for (const [key, value] of Object.entries(parsed.values)) {
        if (!config.values[key]) config.values[key] = value;
      }
    } catch {
      // Optional config source
    }
  }

  // Canonical workspaces keep the tracker in workspace.toml, not the env file.
  config.trackerId ??= workspaceTracker;

  if (
    config.trackerId ||
    config.agentHarness ||
    config.agentCliPath ||
    Object.keys(config.values).length > 0
  ) {
    console.log("✅ Migrating configuration from existing DevIntern config");
  }
  return config;
}

/** Strip matching surrounding quotes from an env value. */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Extract the tracker, credential, and agent keys the non-interactive template knows about. */
function parseMigratedConfig(content: string): MigratedPmConfig {
  const config = emptyMigratedConfig();
  const env = parseEnvContent(content);

  const trackerId = env.TASK_TRACKER?.trim().toLowerCase();
  if (trackerId) config.trackerId = trackerId;

  for (const [key, raw] of Object.entries(env)) {
    const value = unquote(raw.trim());
    if (!value) continue;
    if (key === "AGENT_HARNESS") {
      config.agentHarness = value;
    } else if (key === "AGENT_CLI_PATH" || key === "CLAUDE_CLI_PATH") {
      config.agentCliPath = value;
    } else if (TRACKER_STEP_KEYS.has(key)) {
      config.values[key] = value;
    }
  }

  // Legacy configs may name the owner separately (`GITHUB_REPO=my-repo` plus
  // `GITHUB_OWNER=acme`). The generated .env only writes `GITHUB_REPO`, so fold
  // the owner in; otherwise the migrated repo value has no owner and fails at
  // runtime.
  const repo = config.values.GITHUB_REPO;
  const owner = env.GITHUB_OWNER ? unquote(env.GITHUB_OWNER.trim()) : "";
  if (repo && owner && !repo.includes("/")) {
    config.values.GITHUB_REPO = `${owner}/${repo}`;
  }

  return config;
}

/**
 * Escape a literal for use inside a `RegExp`.
 *
 * @param value - Literal text (env key).
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace the template line for `key`, matching active and commented forms. */
function replaceEnvLine(content: string, key: string, replacement: string): string {
  // Use a function replacement so `$&`, `$'`, `` $` ``, and `$$` in a migrated
  // value (tokens, paths, list names) are written literally instead of being
  // interpreted as replacement patterns.
  return content.replace(
    new RegExp(`^[ \\t]*#?[ \\t]*${escapeRegExp(key)}=.*$`, "m"),
    () => replacement,
  );
}

/** Comment out `key`, keeping the template's own example value when present. */
function commentedEnvLine(content: string, key: string, fallback = ""): string {
  const match = new RegExp(`^[ \\t]*#?[ \\t]*${escapeRegExp(key)}=(.*)$`, "m").exec(content);
  const example = match?.[1]?.trim() || fallback;
  return `# ${key}=${example}`;
}

/**
 * Apply migrated values onto the `.env.example` template.
 *
 * Only values that were actually migrated stay active for the resolved
 * tracker; every other tracker credential is written commented-out so the
 * lower env layers (workspace `.env`, inherited env) can still fill them
 * instead of being shadowed by the template's placeholder values.
 *
 * When no tracker could be resolved, `TASK_TRACKER` is commented out as well:
 * an active `TASK_TRACKER=jira` would otherwise outrank the workspace's
 * `[defaults].tracker` forever and send every run at a bogus Jira host.
 *
 * @param envContent - `.env.example` template contents.
 * @param config - Migrated values to substitute.
 * @returns Template with migrated values written in.
 */
function applyMigratedConfig(envContent: string, config: MigratedPmConfig): string {
  let result = envContent;

  const selected =
    config.trackerId && PM_TRACKER_SETUP[config.trackerId]
      ? new Set(PM_TRACKER_SETUP[config.trackerId]!.map((step) => step.key))
      : undefined;

  const trackerLine = selected
    ? `TASK_TRACKER=${config.trackerId}`
    : commentedEnvLine(result, "TASK_TRACKER", "jira");
  result = replaceEnvLine(result, "TASK_TRACKER", trackerLine);

  for (const steps of Object.values(PM_TRACKER_SETUP)) {
    for (const step of steps) {
      const value = selected?.has(step.key) ? config.values[step.key] : undefined;
      // Active lines must not carry placeholder/fake values that outrank real
      // lower-layer values.
      const replacement = value
        ? `${step.key}=${value}`
        : commentedEnvLine(result, step.key, step.example ?? step.defaultValue ?? "");
      result = replaceEnvLine(result, step.key, replacement);
    }
  }

  if (config.agentHarness) {
    result = result.replace(/AGENT_HARNESS=.*/, () => `AGENT_HARNESS=${config.agentHarness}`);
  }
  if (config.agentCliPath) {
    // The example ships AGENT_CLI_PATH commented out (detection is the default).
    // When migrating an explicit path, write it as an active line.
    result = result.replace(
      /#?\s*AGENT_CLI_PATH=.*/,
      () => `AGENT_CLI_PATH=${config.agentCliPath}`,
    );
  }
  return result;
}

/**
 * Update (or create) `.gitignore` in `cwd` to exclude `.devintern-pm` secret
 * files. Shared by the non-interactive scaffold and the init wizard.
 */
export async function ensureGitignore(cwd: string, log: (m: string) => void = console.log) {
  const gitignorePath = join(cwd, ".gitignore");

  try {
    if (await pathExists(gitignorePath)) {
      let gitignoreContent = await readFile(gitignorePath);

      const hasEnvIgnored = gitignoreContent.includes(".devintern-pm/.env");
      const hasSessionIgnored = gitignoreContent.includes(".devintern-pm/.auth-session.json");

      if (!hasEnvIgnored || !hasSessionIgnored) {
        if (!gitignoreContent.endsWith("\n")) {
          gitignoreContent += "\n";
        }
        gitignoreContent +=
          "\n# devintern-pm configuration (contains secrets)\n.devintern-pm/.env\n.devintern-pm/.auth-session.json\n";
        await writeFile(gitignorePath, gitignoreContent);
        log("✅ Updated .gitignore to exclude @devintern/pm secret files");
      } else {
        log("ℹ️  .gitignore already contains .devintern-pm");
      }
    } else {
      // Create new .gitignore
      const gitignoreContent =
        "# devintern-pm configuration (contains secrets)\n.devintern-pm/.env\n.devintern-pm/.auth-session.json\n";
      await writeFile(gitignorePath, gitignoreContent);
      log("✅ Created .gitignore with @devintern/pm secret files");
    }
  } catch (error) {
    console.warn(
      "⚠️  Could not update .gitignore:",
      error instanceof Error ? error.message : error,
    );
  }
}
