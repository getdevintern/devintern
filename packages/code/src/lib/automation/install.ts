/**
 * Install a bundled automation pack into a workspace.
 *
 * `devintern automations add <pack>` appends one `[[automations]]` entry to
 * `workspace.toml` with the pack prompt inlined as a multi-line string, so the
 * occurrence runs through the normal automation path and the user can edit the
 * prompt in place afterwards.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

import { parseWorkspaceConfig } from "../workspace/config";
import { workerWorkspaceView } from "../workspace/manual-only";
import { workspaceConfigPath } from "../workspace/paths";
import type { CatalogPack } from "./catalog";

export interface InstallCatalogPackOptions {
  workspaceDir: string;
  /**
   * Explicit path to the workspace config file. Defaults to
   * `<workspaceDir>/workspace.toml`. `devintern automations add --workspace`
   * accepts a full file path (matching `worker add`/`worker`), so callers that
   * resolve one pass it here instead of relying on the fixed file name.
   */
  configPath?: string;
  pack: CatalogPack;
  /**
   * Required when the workspace has more than one worker repo (`manual_only`
   * repos are not targets).
   */
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

/**
 * Encode a string as a TOML multi-line basic string (`"""…"""`).
 *
 * The leading newline after the opening delimiter is trimmed by TOML, so the
 * parsed value round-trips exactly. Backslashes, quote runs that could close
 * the string, and control characters other than tab and newline are escaped;
 * single quotes stay as written.
 */
export function tomlMultilineString(value: string): string {
  let escaped = value
    .replace(/\r\n/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(
      // oxlint-disable-next-line no-control-regex -- escaping control characters is the point
      /[\u0000-\u0008\u000B-\u001F\u007F]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`,
    );
  // Only a run of three quotes (or a quote touching the closing delimiter)
  // can end the string early; ordinary quotes stay readable.
  while (escaped.includes('"""')) escaped = escaped.replace('"""', '""\\"');
  if (escaped.endsWith('"')) escaped = `${escaped.slice(0, -1)}\\"`;
  return `"""\n${escaped}"""`;
}

function schedulesEqual(a: CatalogPack["schedule"], b: CatalogPack["schedule"]): boolean {
  return (a.cron ?? "") === (b.cron ?? "") && (a.interval ?? "") === (b.interval ?? "");
}

/**
 * Install one catalog pack into `workspace.toml`.
 *
 * @throws When the id is taken by a different automation, the pack needs a
 *         `repo` in a workspace with several worker repos, `repo` is unknown
 *         or `manual_only`, every configured repo is `manual_only`, or the
 *         resulting config is invalid.
 */
export function installCatalogPack(options: InstallCatalogPackOptions): InstallCatalogPackResult {
  const { workspaceDir, pack } = options;
  const configPath = options.configPath ?? workspaceConfigPath(workspaceDir);
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
  const prompt = pack.prompt.trimEnd();

  const existing = config.automations.find((automation) => automation.id === id);
  if (existing) {
    // Idempotent only when every installed setting matches. A repeat install
    // that changes enabled/open_pr/allow_no_changes/repo/prompt is a conflict,
    // not a no-op: the user may have edited the entry, and it must not be
    // silently overwritten.
    const repoMatches = options.repo === undefined || existing.repo === options.repo;
    if (
      existing.prompt === prompt &&
      schedulesEqual(existing, pack.schedule) &&
      existing.enabled === !options.disabled &&
      (existing.openPr ?? false) === pack.openPr &&
      (existing.allowNoChanges ?? false) === pack.allowNoChanges &&
      repoMatches
    ) {
      return { id, configPath, added: false, repo: existing.repo };
    }
    throw new Error(
      `Automation id "${id}" already exists with different settings. ` +
        `Choose another id with --id, or remove the existing entry first.`,
    );
  }

  // The worker never runs automations on manual_only repos (validation
  // rejects them), so only worker repos are install targets, like `worker add`.
  const workerRepos = workerWorkspaceView(config).repos.map((entry) => entry.name);
  const manualRepos = config.repos.filter((entry) => entry.manualOnly).map((entry) => entry.name);
  if (manualRepos.length > 0 && workerRepos.length === 0) {
    throw new Error(
      `No repos configured for the worker in ${configPath} (manual_only repos are skipped). ` +
        "Run `devintern worker add-repo` inside a checkout first.",
    );
  }
  let repo = options.repo;
  if (repo) {
    if (manualRepos.includes(repo)) {
      throw new Error(
        `Repo "${repo}" is manual_only; the worker does not run automations there. ` +
          `Worker repos: ${workerRepos.join(", ")}.`,
      );
    }
    if (!workerRepos.includes(repo)) {
      throw new Error(
        `Repo "${repo}" does not match any [[repos]] name (${workerRepos.join(", ") || "none"}).`,
      );
    }
  } else if (workerRepos.length > 1) {
    throw new Error(
      `This workspace has multiple repositories; pass --repo <name> (${workerRepos.join(", ")}).`,
    );
  } else if (manualRepos.length > 0) {
    // Pin the single worker repo so the entry cannot be read as aimed at a
    // manual-only checkout.
    repo = workerRepos[0];
  }

  const lines = [
    "",
    `# Installed from automation pack "${pack.id}" (version ${pack.version}). ${pack.description}`,
    "[[automations]]",
    `id = ${tomlBasicString(id)}`,
    `enabled = ${options.disabled ? "false" : "true"}`,
  ];
  if (pack.schedule.cron) lines.push(`cron = ${tomlBasicString(pack.schedule.cron)}`);
  if (pack.schedule.interval) lines.push(`interval = ${tomlBasicString(pack.schedule.interval)}`);
  if (repo) lines.push(`repo = ${tomlBasicString(repo)}`);
  lines.push(`open_pr = ${pack.openPr ? "true" : "false"}`);
  lines.push(`allow_no_changes = ${pack.allowNoChanges ? "true" : "false"}`);
  lines.push(`prompt = ${tomlMultilineString(prompt)}`);
  lines.push("");

  const separator = content.endsWith("\n") ? "" : "\n";
  const updated = `${content}${separator}${lines.join("\n")}`;

  // Validate the whole document before persisting it.
  parseWorkspaceConfig(updated, configPath);
  writeFileSync(configPath, updated);

  return { id, configPath, added: true, repo };
}
