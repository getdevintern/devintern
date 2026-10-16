/**
 * Install a bundled automation pack into a workspace.
 *
 * `devintern automations add <pack>` writes one `[[automations]]` entry into
 * `workspace.toml` (prompt inlined), so the occurrence runs through the normal
 * automation path. A pack that bundles a `pipeline` also gets a workspace
 * pipeline file; the two halves of a pack therefore share one install story.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

import { parseWorkspaceConfig } from "../workspace/config";
import { upsertWorkspaceDefaults } from "../workspace/init";
import { workspaceConfigPath } from "../workspace/paths";
import type { CatalogPack } from "./catalog";

export interface InstallCatalogPackOptions {
  workspaceDir: string;
  pack: CatalogPack;
  /** Required when the workspace has more than one `[[repos]]` entry. */
  repo?: string;
  /** Override the installed automation id (defaults to the pack id). */
  id?: string;
  /** Install disabled (`enabled = false`) so the schedule stays off. */
  disabled?: boolean;
}

export interface InstallCatalogPackResult {
  id: string;
  configPath: string;
  /** false when an identical automation was already installed. */
  added: boolean;
  repo?: string;
  /** Absolute directory holding copied pack references, when any. */
  referencesDir?: string;
  /** Workspace-relative pipeline file written for a pack with a pipeline. */
  pipelineFile?: string;
  warnings: string[];
}

/** Escape a string as a single-line TOML basic string (handles newlines). */
export function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function schedulesEqual(a: CatalogPack["schedule"], b: CatalogPack["schedule"]): boolean {
  return (a.cron ?? "") === (b.cron ?? "") && (a.interval ?? "") === (b.interval ?? "");
}

/**
 * Install one catalog pack into `workspace.toml`.
 *
 * @throws When the id is taken by a different automation, the pack needs a
 *         `repo` in a multi-repo workspace, `repo` does not match a configured
 *         repository, or the resulting config is invalid.
 */
export function installCatalogPack(options: InstallCatalogPackOptions): InstallCatalogPackResult {
  const { workspaceDir, pack } = options;
  const configPath = workspaceConfigPath(workspaceDir);
  if (!existsSync(configPath)) {
    throw new Error(`No workspace.toml at ${configPath}. Run \`devintern worker scaffold\` first.`);
  }

  const content = readFileSync(configPath, "utf8");
  const config = parseWorkspaceConfig(content, configPath);
  const id = options.id ?? pack.id;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(
      `Invalid automation id "${id}": use letters, digits, ".", "_", or "-", starting with a letter or digit.`,
    );
  }
  const warnings: string[] = [];

  // The installed prompt is the pack prompt plus a pointer to any copied
  // reference files. Compute it before the idempotency check so a repeat
  // install compares the fully-rendered prompt, not the bare pack prompt.
  let prompt = pack.prompt.trimEnd();
  let referencesDir: string | undefined;
  if (pack.references.length > 0) {
    referencesDir = join(workspaceDir, "automation-packs", id, "references");
    prompt += `\n\nReference materials for this task are bundled at: ${referencesDir}`;
  }

  const existing = config.automations.find((automation) => automation.id === id);
  if (existing) {
    // Idempotent only when every installed setting matches. A repeat install
    // that changes enabled/open_pr/repo/prompt is a conflict, not a no-op.
    const repoMatches = options.repo === undefined || existing.repo === options.repo;
    if (
      existing.prompt === prompt &&
      schedulesEqual(existing, pack.schedule) &&
      existing.enabled === !options.disabled &&
      (existing.openPr ?? false) === pack.openPr &&
      repoMatches
    ) {
      return {
        id,
        configPath,
        added: false,
        repo: existing.repo,
        warnings,
      };
    }
    throw new Error(
      `Automation id "${id}" already exists with different settings. ` +
        `Choose another id with --id, or remove the existing entry first.`,
    );
  }

  const repos = config.repos.map((entry) => entry.name);
  let repo = options.repo;
  if (repo) {
    if (!repos.includes(repo)) {
      throw new Error(
        `Repo "${repo}" does not match any [[repos]] name (${repos.join(", ") || "none"}).`,
      );
    }
  } else if (repos.length > 1) {
    throw new Error(
      `This workspace has multiple repositories; pass --repo <name> (${repos.join(", ")}).`,
    );
  }

  // Copy pack references next to the workspace so the occurrence can find
  // them. Declared references are pack-relative (e.g. "references/notes.md");
  // flatten to the file name so the copied tree mirrors the declared
  // references/ directory instead of nesting it twice.
  if (referencesDir) {
    for (const reference of pack.references) {
      const source = join(pack.dir, reference);
      const destination = join(referencesDir, basename(reference));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  }

  const lines = [
    "",
    `# Installed from the bundled automation pack "${pack.id}".`,
    "[[automations]]",
    `id = ${tomlBasicString(id)}`,
    `enabled = ${options.disabled ? "false" : "true"}`,
  ];
  if (pack.schedule.cron) lines.push(`cron = ${tomlBasicString(pack.schedule.cron)}`);
  if (pack.schedule.interval) lines.push(`interval = ${tomlBasicString(pack.schedule.interval)}`);
  if (repo) lines.push(`repo = ${tomlBasicString(repo)}`);
  lines.push(`open_pr = ${pack.openPr ? "true" : "false"}`);
  lines.push(`prompt = ${tomlBasicString(prompt)}`);
  lines.push("");

  const separator = content.endsWith("\n") ? "" : "\n";
  let updated = `${content}${separator}${lines.join("\n")}`;

  // Optional bundled pipeline: write the file and point [defaults] at it,
  // unless the workspace already declares a default pipeline.
  let pipelineFile: string | undefined;
  if (pack.pipeline) {
    const relativePipeline = join("pipelines", `${id}.json`);
    const pipelinePath = join(workspaceDir, relativePipeline);
    if (config.defaults.pipelineFile && config.defaults.pipelineFile !== relativePipeline) {
      warnings.push(
        `Pack "${pack.id}" bundles a pipeline, but [defaults].pipeline_file is already ` +
          `"${config.defaults.pipelineFile}"; left it unchanged. Merge ${pipelinePath} manually.`,
      );
    } else {
      mkdirSync(dirname(pipelinePath), { recursive: true });
      // Workspace pipeline files are top-level `{ steps, plugins }` (the
      // shape `loadPipelineConfigFile`/`resolvePipelineSteps` read), not the
      // nested `{ pipeline: {...} }` shape settings.json uses.
      const document = {
        ...(pack.pipeline.plugins ? { plugins: pack.pipeline.plugins } : {}),
        steps: pack.pipeline.steps,
      };
      writeFileSync(pipelinePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      updated = upsertWorkspaceDefaults(updated, {
        pipelineFile: relativePipeline.split("\\").join("/"),
      });
      pipelineFile = relativePipeline;
    }
  }

  // Validate the whole document before persisting it.
  parseWorkspaceConfig(updated, configPath);
  writeFileSync(configPath, updated);

  return { id, configPath, added: true, repo, referencesDir, pipelineFile, warnings };
}
