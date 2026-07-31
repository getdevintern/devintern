/**
 * Current project session for the main process.
 *
 * The app operates on a user-chosen project directory (same mental model as
 * the CLI: credentials live in `<project>/.devintern-pm/.env`). Nothing uses
 * `process.chdir` — the project dir is threaded through the `baseDir`
 * parameters on pm's config loaders.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createEngine, type PmEngine } from "@getdevintern/pm/engine";
import { loadConfig, migrateLegacyConfigDir, type Config } from "@getdevintern/pm/config";
import type { ProjectStatus } from "../shared/ipc-contract.ts";

export interface Session {
  projectDir: string;
  config: Config;
  engine: PmEngine;
}

let current: Session | null = null;

export function getSession(): Session | null {
  return current;
}

export function requireSession(): Session {
  if (!current) {
    throw new Error("No project selected. Choose a project directory first.");
  }
  return current;
}

/**
 * Resolve the pm package's bundled prompts/ directory.
 *
 * The engine gets bundled into out/main by electron-vite, so its own
 * module-relative default would point at the wrong place.
 */
function resolvePromptsDir(): string {
  const require = createRequire(import.meta.url);
  const pmPackageJson = require.resolve("@getdevintern/pm/package.json");
  return join(dirname(pmPackageJson), "prompts");
}

/**
 * Load (or reload) the session for a project directory and report its status.
 *
 * Config problems are reported in the returned status rather than thrown,
 * so the renderer can guide the user instead of crashing.
 */
export async function loadProject(projectDir: string): Promise<ProjectStatus> {
  current = null;

  const status: ProjectStatus = {
    projectDir,
    configured: false,
  };

  try {
    await migrateLegacyConfigDir(projectDir);
    const config = await loadConfig(projectDir);
    const engine = await createEngine(config, {
      promptsDir: resolvePromptsDir(),
      baseDir: projectDir,
    });
    current = { projectDir, config, engine };

    status.configured = true;
    status.backendName = engine.backendName;
    status.harnessDisplayName = config.agent.harness.displayName;
    status.supportsIssueTypes = engine.supportsIssueTypes;
    status.supportsEpicLinking = engine.supportsEpicLinking;
    status.defaultProjectKey = engine.defaultProjectKey;

    try {
      status.projects = await engine.listProjects();
    } catch {
      // Non-fatal: the composer works without a project list.
    }
    if (engine.supportsIssueTypes) {
      try {
        status.issueTypes = await engine.listIssueTypes(status.defaultProjectKey);
      } catch {
        status.issueTypes = ["Task", "Story", "Bug", "Epic"];
      }
    }
  } catch (error) {
    status.configError = error instanceof Error ? error.message : String(error);
  }

  return status;
}
