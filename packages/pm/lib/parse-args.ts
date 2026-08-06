/**
 * CLI argument parser for `@getdevintern/pm`.
 *
 * Extracted from `index.ts` so it can be unit-tested without booting the
 * full CLI. Harness name lookup is intentionally NOT done here; the caller
 * is the single source of truth for harness validation (so the same error
 * message is constructed exactly once and works in both interactive and
 * non-interactive modes).
 */

import { getHarness, listHarnesses } from "@devintern/agent-harness";
import type { SourceInput } from "./engine/index.js";

export interface CLIArgs {
  source: SourceInput;
  epicKey?: string;
  extraInstructions?: string;
  promptStyle: "technical" | "pm";
  decompose: boolean;
  confirm: boolean;
  model?: string;
  issueType: string;
}

export type ParsedArgs = CLIArgs | null | "init";

/**
 * Parse CLI arguments from an argv slice (typically `getArgs()`).
 *
 * @param argv - Raw argv without the node/bun binary and script path.
 * @returns Parsed task-creation args, `null` for interactive mode, `"init"`,
 *   or exits the process on `--help`/validation errors.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv;

  // Check for init command early
  if (args.includes("init") || args.includes("--init")) {
    return "init"; // Signal to run init
  }

  // Check for interactive mode early
  if (args.includes("--interactive")) {
    return null; // Signal to use interactive mode
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: devpm init [--yes]
       devpm --figma <url> [options]
       devpm --log <text> [options]
       devpm --prompt <text> [options]
       devpm --interactive

Commands:
  init                 Initialize .devintern-pm configuration in current directory
                       (guided wizard; --yes or --no-interactive writes the template instead)

Modes:
  --interactive        Interactive mode - step-by-step task creation (recommended)

Source (one required for non-interactive mode):
  --figma <url>        Figma design node URL to analyze
  --log <text>         Error log or bug report text to analyze
  --prompt <text>      Free-form text describing requirements or features

Options:
  --epic, -e <key>     Epic key to link the story to (e.g., PROJ-100)
  --type, -t <type>    Issue type (default: "Task")
                        Common types: Task, Story, Bug, Epic
  --custom, -c <text>  Additional custom instructions for the requirements
  --style, -s <type>   Prompt style: "pm" (default) or "technical"
                        - pm: Focuses on user stories and acceptance criteria
                        - technical: Includes Technical Considerations section
  --model, -m <model>  Model to use (agent-specific, e.g., "sonnet", "opus", or provider/model)
  --harness <name>     AI agent harness to use (e.g., "claude-code", "opencode", "codex")
  --decompose          Decompose the story into subtasks (default: off)
  --confirm            Interactively confirm each subtask before creating
  --verbose, -v        Enable verbose API logging for debugging
  --help, -h           Show this help message

Environment variables (set in .env):
  TASK_TRACKER        Task tracker to use: jira | linear | trello | azure-devops | asana | github | markdown (default: jira)
  MARKDOWN_TASKS_DIR  Directory for markdown tasks (default: .devintern-pm/tasks)
  JIRA_BASE_URL       Your JIRA instance URL (e.g., https://your-org.atlassian.net)
  JIRA_EMAIL          Your Jira email
  JIRA_API_TOKEN      Your Jira API token
  JIRA_DEFAULT_PROJECT_KEY  Your Jira project key (e.g., PROJ)
  LINEAR_API_KEY      Your Linear API token (create at https://linear.app/settings/api)
  LINEAR_DEFAULT_TEAM_KEY   Default Linear team key (e.g., ENG)
  TRELLO_API_KEY      Your Trello API key (create at https://trello.com/app-key)
  TRELLO_API_TOKEN    Your Trello API token (generated from app-key page)
  TRELLO_DEFAULT_BOARD_ID   Default Trello board ID (optional)
  TRELLO_DEFAULT_LIST_NAME  Default Trello list name (optional, e.g. "To Do")
  AZURE_DEVOPS_ORG    Your Azure DevOps organization name
  AZURE_DEVOPS_PAT    Your Azure DevOps Personal Access Token
  AZURE_DEVOPS_PROJECT      Default Azure DevOps project name
  ASANA_API_TOKEN     Your Asana Personal Access Token
  ASANA_DEFAULT_PROJECT_GID Default Asana project GID (optional)
  GITHUB_TOKEN        Your GitHub Personal Access Token
  GITHUB_REPO         Target repository as owner/repo (e.g. acme/my-app)
  AGENT_HARNESS       Default AI agent harness (overridden by --harness)
  AGENT_CLI_PATH      Optional path/command for the agent CLI (PATH lookup by default)

Examples:
  # Interactive mode (recommended)
  devpm --interactive            # Step-by-step task creation
  devpm --interactive --harness opencode

  # Figma designs
  devpm --figma "https://www.figma.com/design/abc/file?node-id=123-456"
  devpm --figma "https://..." --epic PROJ-100
  devpm --figma "https://..." -c "Focus on accessibility"
  devpm --figma "https://..." --style technical --decompose
  devpm --figma "https://..." --type Task

  # Error logs
  devpm --log "Error: Cannot read property 'id' of undefined at line 42"
  devpm --log "$(cat error.log)" --epic PROJ-200 --type Bug
  devpm --log "Stack trace..." --style technical --model opus

  # Free-form prompts
  devpm --prompt "Add user profile settings page with theme preferences"
  devpm --prompt "$(cat requirements.txt)" --epic PROJ-300
  devpm --prompt "Implement OAuth login" --style technical --decompose
  devpm --prompt "..." --harness codex
    `);
    process.exit(0);
  }

  let source: SourceInput | undefined;
  let epicKey: string | undefined;
  let customInstructions: string | undefined;
  let promptStyle: "technical" | "pm" = "pm"; // Default to pm
  let decompose = false; // Default to NOT decomposing
  let confirm = false;
  let model: string | undefined;
  let issueType = "Task"; // Default to Task

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue; // Skip undefined args (shouldn't happen but satisfies TS)

    if (arg === "--figma") {
      if (i + 1 >= args.length) {
        console.error("Error: --figma requires a URL");
        process.exit(1);
      }
      if (source) {
        console.error("Error: Cannot specify multiple source types (--figma, --log, --prompt)");
        process.exit(1);
      }
      source = {
        type: "figma",
        content: args[i + 1]!,
      };
      i++; // Skip next arg
    } else if (arg === "--log") {
      if (i + 1 >= args.length) {
        console.error("Error: --log requires text content");
        process.exit(1);
      }
      if (source) {
        console.error("Error: Cannot specify multiple source types (--figma, --log, --prompt)");
        process.exit(1);
      }
      source = {
        type: "log",
        content: args[i + 1]!,
      };
      i++; // Skip next arg
    } else if (arg === "--prompt") {
      if (i + 1 >= args.length) {
        console.error("Error: --prompt requires text content");
        process.exit(1);
      }
      if (source) {
        console.error("Error: Cannot specify multiple source types (--figma, --log, --prompt)");
        process.exit(1);
      }
      source = {
        type: "prompt",
        content: args[i + 1]!,
      };
      i++; // Skip next arg
    } else if (arg === "--epic" || arg === "-e") {
      if (i + 1 >= args.length) {
        console.error("Error: --epic requires a value");
        process.exit(1);
      }
      epicKey = args[i + 1]!; // Non-null assertion safe due to check above
      i++; // Skip next arg
    } else if (arg === "--type" || arg === "-t") {
      if (i + 1 >= args.length) {
        console.error("Error: --type requires a value");
        process.exit(1);
      }
      issueType = args[i + 1]!; // Non-null assertion safe due to check above
      i++; // Skip next arg
    } else if (arg === "--custom" || arg === "-c") {
      if (i + 1 >= args.length) {
        console.error("Error: --custom requires a value");
        process.exit(1);
      }
      customInstructions = args[i + 1]!; // Non-null assertion safe due to check above
      i++; // Skip next arg
    } else if (arg === "--style" || arg === "-s") {
      if (i + 1 >= args.length) {
        console.error("Error: --style requires a value");
        process.exit(1);
      }
      const style = args[i + 1]!;
      if (style !== "technical" && style !== "pm") {
        console.error('Error: --style must be either "technical" or "pm"');
        process.exit(1);
      }
      promptStyle = style;
      i++; // Skip next arg
    } else if (arg === "--model" || arg === "-m") {
      if (i + 1 >= args.length) {
        console.error("Error: --model requires a value");
        process.exit(1);
      }
      model = args[i + 1]!; // Non-null assertion safe due to check above
      i++; // Skip next arg
    } else if (arg === "--harness") {
      // Consumed by extractHarnessFlags() before parseArgs() runs; the value
      // is validated exactly once in main(). Skip here to avoid treating it
      // as an unknown argument.
      if (i + 1 >= args.length) {
        console.error("Error: --harness requires a value");
        process.exit(1);
      }
      i++;
    } else if (arg === "--decompose") {
      decompose = true;
    } else if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--verbose" || arg === "-v") {
      // Handled before parseArgs() is called; skip here
      continue;
    } else if (arg === "--yes" || arg === "--no-interactive") {
      // Init-only flags; ignored outside init (init returns early above).
      continue;
    } else {
      console.error(`Error: Unknown argument "${arg}"`);
      console.error("Use --help to see available options");
      process.exit(1);
    }
  }

  if (!source) {
    console.error("Error: Source is required (use --figma, --log, or --prompt)");
    process.exit(1);
  }

  return {
    source,
    epicKey,
    promptStyle,
    decompose,
    confirm,
    model,
    issueType,
    extraInstructions: customInstructions,
  };
}

/**
 * Extract the `--harness` value from raw argv before full parsing.
 *
 * Needed for interactive mode (where {@link parseArgs} returns `null` early)
 * and for the single validation path in `main()`. Returns the raw string only;
 * the caller is responsible for validating it against the harness registry.
 *
 * @param args - Raw argv slice.
 * @returns The harness name if present, otherwise `undefined`.
 */
export function extractHarnessFlags(args: string[]): { harness?: string } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--harness") {
      if (i + 1 >= args.length) {
        console.error("Error: --harness requires a value");
        process.exit(1);
      }
      return { harness: args[i + 1] };
    }
  }
  return {};
}

/**
 * Validate a harness name against the registry and exit on unknown values.
 *
 * No-op when `harnessName` is undefined (caller falls back to env/default).
 *
 * @param harnessName - Raw harness name from `--harness` or the interactive picker.
 */
export function validateHarnessName(harnessName: string | undefined): void {
  if (!harnessName) return;
  if (getHarness(harnessName)) return;

  const available = listHarnesses()
    .map((h) => `"${h.name}"`)
    .join(", ");
  console.error(`Error: Unknown agent harness "${harnessName}". Available harnesses: ${available}`);
  process.exit(1);
}
