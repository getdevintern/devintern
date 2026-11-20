/**
 * `devintern automations <list|show|add>` — work with the bundled automation
 * catalog.
 *
 * `add` installs a pack by writing a `[[automations]]` entry into
 * `workspace.toml`; the occurrence then runs through the normal automation
 * path. The catalog itself is read-only and ships with the package.
 */

import { existsSync } from "fs";
import { dirname, resolve } from "path";

import { loadCatalogPack, listCatalogPacks } from "./catalog";
import type { CatalogPackSummary } from "./catalog";
import { installCatalogPack } from "./install";
import { resolveWorkspaceDir, workspaceConfigPath } from "../workspace/paths";

const HELP = `Usage: devintern automations <command> [options]

Bundled, shareable automation recipes. Installing a pack writes one
[[automations]] entry into workspace.toml; occurrences then run through the
normal task pipeline.

Commands:
  list                 List bundled packs (id, schedule, opens PR)
  show <pack>          Show a pack's prompt and settings
  add <pack>           Install a pack into workspace.toml

Options for add:
  --workspace <path>   Path to workspace.toml (default: ~/.devintern/workspace.toml)
  --repo <name>        Target [[repos]] name (required in a multi-repo workspace)
  --id <id>            Override the installed automation id
  --disabled           Install with enabled = false
  -h, --help           Display this help message

Examples:
  devintern automations list
  devintern automations add dependency-health
  devintern automations add log-triage --repo backend
`;

function formatSchedule(schedule: { cron?: string; interval?: string }): string {
  if (schedule.cron) return `cron ${schedule.cron}`;
  if (schedule.interval) return `every ${schedule.interval}`;
  return "no schedule";
}

function renderIssueWarnings(issues: { level: string; message: string }[]): void {
  for (const issue of issues) {
    const icon = issue.level === "error" ? "❌" : "⚠️ ";
    console.error(`${icon} ${issue.message}`);
  }
}

/**
 * Resolve the workspace directory and config file path from `--workspace`.
 *
 * `--workspace` is the path to `workspace.toml` (matching `worker`/`worker
 * add`), so the file name is honored rather than assumed: passing
 * `--workspace /w/custom.toml` installs into `custom.toml`.
 */
function workspacePathsFromFlags(workspacePath: string | undefined): {
  workspaceDir: string;
  configPath: string;
} {
  if (!workspacePath) {
    const workspaceDir = resolveWorkspaceDir();
    return { workspaceDir, configPath: workspaceConfigPath(workspaceDir) };
  }
  const configPath = resolve(workspacePath);
  return { workspaceDir: dirname(configPath), configPath };
}

/** `devintern automations list` */
function runList(): never {
  const { packs, issues } = listCatalogPacks();
  if (packs.length === 0) {
    console.log("No automation packs are bundled.");
  } else {
    const idWidth = Math.max(...packs.map((pack) => pack.id.length), 4);
    for (const pack of packs) {
      console.log(
        `${pack.id.padEnd(idWidth)}  ${formatSchedule(pack.schedule).padEnd(22)}  ` +
          `${pack.openPr ? "opens PR" : "no PR"}`,
      );
      console.log(`${" ".repeat(idWidth)}  ${pack.description}`);
    }
  }
  renderIssueWarnings(issues);
  process.exit(issues.some((issue) => issue.level === "error") ? 1 : 0);
}

function printPack(summary: CatalogPackSummary, prompt: string): void {
  console.log(`${summary.name} (${summary.id})`);
  console.log(`  ${summary.description}`);
  console.log(`  schedule: ${formatSchedule(summary.schedule)}`);
  console.log(`  opens PR: ${summary.openPr ? "yes" : "no"}`);
  console.log("");
  console.log(prompt.trimEnd());
}

/** `devintern automations show <pack>` */
function runShow(args: string[]): never {
  const id = args.find((arg) => !arg.startsWith("-"));
  if (!id) {
    console.error("❌ Usage: devintern automations show <pack>");
    process.exit(1);
  }
  let pack;
  try {
    pack = loadCatalogPack(id);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  }
  printPack(pack, pack.prompt);
  process.exit(0);
}

interface AddFlags {
  workspacePath?: string;
  repo?: string;
  id?: string;
  disabled: boolean;
  packId?: string;
}

function parseAddFlags(args: string[]): { flags: AddFlags; error?: string } {
  const flags: AddFlags = { disabled: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Normalize the `--key=value` form so it matches the same branches as
    // `--key value`; a typo like `--worksapce` then fails instead of silently
    // falling back to the default workspace.toml.
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const nextValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return undefined;
      i++;
      return value;
    };
    if (name === "--workspace") {
      const value = nextValue();
      if (!value) return { flags, error: "--workspace requires a path to workspace.toml." };
      flags.workspacePath = value;
    } else if (name === "--repo") {
      const value = nextValue();
      if (!value) return { flags, error: "--repo requires a repository name." };
      flags.repo = value;
    } else if (name === "--id") {
      const value = nextValue();
      if (!value) return { flags, error: "--id requires an automation id." };
      flags.id = value;
    } else if (name === "--disabled") {
      if (inlineValue !== undefined) return { flags, error: "--disabled does not take a value." };
      flags.disabled = true;
    } else if (!arg.startsWith("-") && !flags.packId) {
      flags.packId = arg;
    } else {
      return {
        flags,
        error: `Unknown ${arg.startsWith("-") ? "option" : "argument"} "${arg}".`,
      };
    }
  }
  return { flags };
}

/** `devintern automations add <pack> [options]` */
function runAdd(args: string[]): never {
  const { flags, error } = parseAddFlags(args);
  if (error) {
    console.error(`❌ ${error}`);
    process.exit(1);
  }
  if (!flags.packId) {
    console.error(
      "❌ Usage: devintern automations add <pack> [--workspace <path>] [--repo <name>]",
    );
    process.exit(1);
  }

  const { workspaceDir, configPath } = workspacePathsFromFlags(flags.workspacePath);
  if (!existsSync(configPath)) {
    console.error(`❌ No workspace.toml at ${configPath}.`);
    console.error("   Run `devintern worker scaffold` first.");
    process.exit(1);
  }

  let result;
  try {
    const pack = loadCatalogPack(flags.packId);
    result = installCatalogPack({
      workspaceDir,
      configPath,
      pack,
      repo: flags.repo,
      id: flags.id,
      disabled: flags.disabled,
    });
  } catch (installError) {
    console.error(`❌ ${(installError as Error).message}`);
    process.exit(1);
  }

  if (!result.added) {
    console.log(`ℹ️  Automation "${result.id}" is already installed; unchanged.`);
    process.exit(0);
  }
  console.log(`✅ Installed "${result.id}" into ${result.configPath}`);
  if (result.repo) console.log(`   Repo: ${result.repo}`);
  if (result.referencesDir) console.log(`   References: ${result.referencesDir}`);
  if (result.pipelineFile) console.log(`   Pipeline: ${result.pipelineFile}`);
  for (const warning of result.warnings) console.warn(`⚠️  ${warning}`);
  console.log("   Start or reload `devintern worker` to pick it up.");
  process.exit(0);
}

/** Dispatch `devintern automations <command>`. */
export async function runAutomationsCommand(args: string[]): Promise<never> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (command === "list") return runList();
  if (command === "show") return runShow(rest);
  if (command === "add") return runAdd(rest);
  console.error(`❌ Unknown automations command: ${command}`);
  console.error("   Run `devintern automations --help` for available commands.");
  process.exit(1);
}
