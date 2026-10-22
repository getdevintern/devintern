/**
 * Selects the one pipeline a routed task runs.
 *
 * A task subprocess can see four layers of pipeline configuration:
 *
 * 1. An automation-scoped override (`[[automations]].pipeline_file`), pinned
 *    into the subprocess environment only for that automation's occurrences.
 * 2. A workspace per-repository override (`[[repos]].pipeline_file`), pinned
 *    into the subprocess environment by the fleet worker.
 * 3. The repository's checked-in `.devintern-code/settings.json` pipeline.
 * 4. A workspace-wide default (`[defaults].pipeline_file`).
 *
 * Exactly one complete definition is selected — ordered step arrays are never
 * merged across scopes. When none is present the built-in default applies.
 *
 * Relative plugin and verification prompt paths declared by a workspace file
 * resolve against that file's directory; repository settings keep resolving
 * against the repository worktree (the process working directory).
 */

import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

import type { PipelineConfig, ProjectSettings } from "../../types/settings";
import {
  WORKSPACE_PIPELINE_AUTOMATION_ENV,
  WORKSPACE_PIPELINE_DEFAULT_ENV,
  WORKSPACE_PIPELINE_REPO_ENV,
} from "../workspace/env";
import { DEFAULT_PIPELINE } from "./pipeline-config";

/** Where the selected pipeline definition came from. */
export type PipelineScope =
  | "automation"
  | "workspace-repo"
  | "repository"
  | "workspace-default"
  | "built-in";

/** The complete pipeline chosen for one task, with its configuration source. */
export interface SelectedPipeline {
  /** Selected definition; `undefined` means the built-in default. */
  config?: PipelineConfig;
  /** Which scope won the precedence lookup. */
  scope: PipelineScope;
  /** Declaring file, or `null` for the built-in default. */
  sourcePath: string | null;
  /**
   * Base directory for resolving relative plugin modules, package plugins,
   * and (for workspace files) verification prompts.
   */
  baseDir: string;
}

/**
 * Read and parse a workspace pipeline definition file.
 *
 * Fails loudly for a missing file or invalid JSON, naming the file so an
 * operator can fix the reference. Step ordering and plugin definitions are
 * validated later by `resolvePipelineSteps` before implementation starts.
 *
 * @param path - Absolute path of the JSON pipeline file.
 */
export function loadPipelineConfigFile(path: string): PipelineConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read pipeline file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in pipeline file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Pipeline file ${path} must contain a JSON object`);
  }
  const config = parsed as PipelineConfig;
  if (config.steps !== undefined && !Array.isArray(config.steps)) {
    throw new Error(`Pipeline file ${path}: "steps" must be an array`);
  }
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
    throw new Error(`Pipeline file ${path}: "plugins" must be an array`);
  }
  return config;
}

/**
 * Make relative plugin and verification prompt paths in a workspace pipeline
 * definition absolute against the declaring file's directory.
 *
 * Package plugin names and inline `verify.prompt` instructions are left
 * untouched. A relative `verify.prompt` is only treated as a path when the
 * file exists next to the declaring configuration, mirroring how
 * `verify.ts` distinguishes a prompt file from inline instructions.
 */
export function resolveWorkspaceRelativePaths(
  config: PipelineConfig,
  baseDir: string,
): PipelineConfig {
  const plugins = config.plugins?.map((entry) =>
    typeof entry === "string" && entry.startsWith(".") && !isAbsolute(entry)
      ? resolve(baseDir, entry)
      : entry,
  );
  const steps = config.steps?.map((step) => {
    if (step.use !== "verify" || typeof step.prompt !== "string") return step;
    const { prompt } = step;
    if (isAbsolute(prompt)) return step;
    const candidate = resolve(baseDir, prompt);
    return existsSync(candidate) ? { ...step, prompt: candidate } : step;
  });
  return {
    ...config,
    ...(typeof config.artifacts?.publish?.uploader === "string" &&
    config.artifacts.publish.uploader.startsWith(".")
      ? {
          artifacts: {
            ...config.artifacts,
            publish: {
              ...config.artifacts.publish,
              uploader: resolve(baseDir, config.artifacts.publish.uploader),
            },
          },
        }
      : {}),
    ...(plugins ? { plugins } : {}),
    ...(steps ? { steps } : {}),
  };
}

/**
 * Resolve the pipeline a task should run, honoring scope precedence.
 *
 * Precedence: automation override > workspace per-repository override >
 * repository `.devintern-code/settings.json` pipeline > workspace default >
 * built-in default. A referenced workspace file that is missing or invalid
 * throws (never a silent fallback).
 *
 * @param input.settings - Parsed repository settings, or `null`.
 * @param input.cwd - Repository worktree (the process working directory).
 * @param input.env - Environment carrying workspace pipeline references
 *                    (defaults to `process.env`).
 */
export function selectPipelineConfig(input: {
  settings: ProjectSettings | null;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): SelectedPipeline {
  const env = input.env ?? process.env;

  const automationFile = env[WORKSPACE_PIPELINE_AUTOMATION_ENV];
  if (automationFile) {
    const baseDir = dirname(automationFile);
    return {
      config: resolveWorkspaceRelativePaths(loadPipelineConfigFile(automationFile), baseDir),
      scope: "automation",
      sourcePath: automationFile,
      baseDir,
    };
  }

  const repoFile = env[WORKSPACE_PIPELINE_REPO_ENV];
  if (repoFile) {
    const baseDir = dirname(repoFile);
    return {
      config: resolveWorkspaceRelativePaths(loadPipelineConfigFile(repoFile), baseDir),
      scope: "workspace-repo",
      sourcePath: repoFile,
      baseDir,
    };
  }

  const settingsPipeline = input.settings?.pipeline;
  if (settingsPipeline) {
    return {
      config: settingsPipeline,
      scope: "repository",
      sourcePath: join(input.cwd, ".devintern-code", "settings.json"),
      baseDir: input.cwd,
    };
  }

  const defaultFile = env[WORKSPACE_PIPELINE_DEFAULT_ENV];
  if (defaultFile) {
    const baseDir = dirname(defaultFile);
    return {
      config: resolveWorkspaceRelativePaths(loadPipelineConfigFile(defaultFile), baseDir),
      scope: "workspace-default",
      sourcePath: defaultFile,
      baseDir,
    };
  }

  return { config: undefined, scope: "built-in", sourcePath: null, baseDir: input.cwd };
}

/** Human-readable step sequence for the selected (or built-in) pipeline. */
export function pipelineStepSequence(config: PipelineConfig | undefined): string {
  return (config?.steps ?? DEFAULT_PIPELINE).map((step) => step.use).join(" → ");
}

/**
 * Describe a selection for task logs: scope, declaring file, and step
 * sequence. Contains only configuration paths and step names — never values.
 */
export function describePipelineSelection(
  selection: SelectedPipeline,
  config: PipelineConfig | undefined,
): string {
  const source =
    selection.scope === "built-in"
      ? "built-in default"
      : `${selection.scope} (${selection.sourcePath})`;
  return `${source}: ${pipelineStepSequence(config)}`;
}
