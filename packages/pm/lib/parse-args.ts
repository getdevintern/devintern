/**
 * CLI argument parser for `@getdevintern/pm`.
 *
 * Extracted from `index.ts` so it can be unit-tested without booting the
 * full CLI. Harness name lookup is intentionally NOT done here; the caller
 * is the single source of truth for harness validation (so the same error
 * message is constructed exactly once and works in both interactive and
 * non-interactive modes).
 */

import { resolve } from "node:path";
import { getHarness, listHarnesses, parseAgentEffort } from "@devintern/agent-harness";
import type { AgentEffort } from "@devintern/agent-harness";
import type { SourceInput } from "./engine/index.js";

export interface CLIArgs {
  source: SourceInput;
  epicKey?: string;
  extraInstructions?: string;
  promptStyle: "technical" | "pm";
  decompose: boolean;
  confirm: boolean;
  model?: string;
  effort?: AgentEffort;
  issueType: string;
  /** Local files for agent context and post-create upload. */
  attachments?: Array<{ path: string }>;
}

export type ParsedArgs =
  | CLIArgs
  | null
  | "init"
  | "login"
  | "logout"
  | "whoami"
  | "serve"
  | { connect: string };

/**
 * Canonical option names. Short aliases map onto the long form so the parse
 * loop can test a single canonical name instead of a chain of `||` aliases.
 */
const FLAG_ALIASES: Record<string, string> = {
  "--figma": "figma",
  "--log": "log",
  "--prompt": "prompt",
  "--epic": "epic",
  "-e": "epic",
  "--type": "type",
  "-t": "type",
  "--custom": "custom",
  "-c": "custom",
  "--attach": "attach",
  "--style": "style",
  "-s": "style",
  "--model": "model",
  "-m": "model",
  "--effort": "effort",
  "--harness": "harness",
  "--decompose": "decompose",
  "--confirm": "confirm",
  "--verbose": "verbose",
  "-v": "verbose",
  "--no-update": "no-update",
  "--version": "version",
  "-V": "version",
  "--yes": "yes",
  "--no-interactive": "no-interactive",
};

const HELP_TEXT = `
Usage: devpm init [--yes]
       devpm login [method|email]
       devpm logout
       devpm whoami
       devpm connect <telegram|slack>
       devpm serve [--platform <slack|telegram>]
       devpm --figma <url> [options]
       devpm --log <text> [options]
       devpm --prompt <text> [options]
       devpm --interactive

Commands:
  init                 Initialize .devintern-pm configuration in current directory
                       (guided wizard; --yes or --no-interactive writes the template instead)
  login [method]       Sign in (github | google | x | email; prompts if omitted)
  logout               Clear local auth session
  whoami               Show current authenticated user
  connect <platform>   Set up a chat platform bot (Telegram or Slack)
  serve                Run the chat bot daemon (create tasks from Slack/Telegram)

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
  --attach <path>      Attach a local file for agent context (and upload on create when
                        the tracker supports it). Repeatable. Supported: images, text/docs,
                        pdf (not .docx/.xlsx). Max 10 files.
  --style, -s <type>   Prompt style: "pm" (default) or "technical"
                        - pm: Focuses on user stories and acceptance criteria
                        - technical: Includes Technical Considerations section
  --model, -m <model>  Model to use (agent-specific, e.g., "sonnet", "opus", or provider/model)
  --effort <level>     Reasoning effort for agent runs: low, medium, or high.
                        Overrides the AGENT_EFFORT environment variable; emitted by
                        harnesses that support reasoning effort (claude-code, grok,
                        antigravity, deepseek, cline, opencode, kilo-code, codex, pi),
                        ignored by the others (with a warning).
  --harness <name>     AI agent harness to use (e.g., "claude-code", "opencode", "codex")
  --decompose          Decompose the story into subtasks (default: off)
  --confirm            Interactively confirm each subtask before creating
  --no-update          Skip the npm update check for this run
  --verbose, -v        Enable verbose API logging for debugging
  --version, -V        Print the CLI version
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
  AGENT_MODEL         Default agent model (overridden by --model)
  AGENT_EFFORT        Reasoning effort for agent runs: low | medium | high (overridden by --effort)
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
  devpm --prompt "Refine checkout" --attach ./notes.md --attach ./shot.png
    `;

/** Detect command sentinels (`init`, `login`, `serve`, …) before option parsing. */
function detectCommand(args: string[]): ParsedArgs | undefined {
  if (args.includes("init") || args.includes("--init")) return "init";
  if (args.includes("login")) return "login";
  if (args.includes("logout")) return "logout";
  if (args.includes("whoami")) return "whoami";
  if (args[0] === "serve") return "serve";
  if (args[0] === "connect") return { connect: args[1] ?? "" };
  return undefined;
}

/** Print usage and exit when help was requested or no args were supplied. */
function showHelpIfRequested(args: string[]): void {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
}

/** Read the value following a flag, or exit with `message` when it is missing. */
function readOptionValue(args: string[], index: number, message: string): string {
  if (index + 1 >= args.length) {
    console.error(message);
    process.exit(1);
  }
  return args[index + 1]!;
}

/** Assign the single source input, rejecting a second source flag. */
function assignSource(
  current: SourceInput | undefined,
  type: SourceInput["type"],
  content: string,
): SourceInput {
  if (current) {
    console.error("Error: Cannot specify multiple source types (--figma, --log, --prompt)");
    process.exit(1);
  }
  return { type, content };
}

/** Validate a `--style` value, exiting on anything but `pm`/`technical`. */
function parsePromptStyle(value: string): "technical" | "pm" {
  if (value === "technical" || value === "pm") return value;
  console.error('Error: --style must be either "technical" or "pm"');
  process.exit(1);
}

/**
 * Parse CLI arguments from an argv slice (typically `getArgs()`).
 *
 * @param argv - Raw argv without the node/bun binary and script path.
 * @returns Parsed task-creation args, `null` for interactive mode, a command sentinel,
 *   or exits the process on `--help`/validation errors.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv;

  const command = detectCommand(args);
  if (command !== undefined) return command;

  // Check for interactive mode early
  if (args.includes("--interactive")) {
    return null; // Signal to use interactive mode
  }

  showHelpIfRequested(args);

  let source: SourceInput | undefined;
  let epicKey: string | undefined;
  let customInstructions: string | undefined;
  let promptStyle: "technical" | "pm" = "pm"; // Default to pm
  let decompose = false; // Default to NOT decomposing
  let confirm = false;
  let model: string | undefined;
  let effort: AgentEffort | undefined;
  let issueType = "Task"; // Default to Task
  const attachments: Array<{ path: string }> = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    const flag = FLAG_ALIASES[arg] ?? arg;
    let consumed = 1;

    if (flag === "figma") {
      source = assignSource(
        source,
        "figma",
        readOptionValue(args, i, "Error: --figma requires a URL"),
      );
      consumed = 2;
    } else if (flag === "log") {
      source = assignSource(
        source,
        "log",
        readOptionValue(args, i, "Error: --log requires text content"),
      );
      consumed = 2;
    } else if (flag === "prompt") {
      source = assignSource(
        source,
        "prompt",
        readOptionValue(args, i, "Error: --prompt requires text content"),
      );
      consumed = 2;
    } else if (flag === "epic") {
      epicKey = readOptionValue(args, i, "Error: --epic requires a value");
      consumed = 2;
    } else if (flag === "type") {
      issueType = readOptionValue(args, i, "Error: --type requires a value");
      consumed = 2;
    } else if (flag === "custom") {
      customInstructions = readOptionValue(args, i, "Error: --custom requires a value");
      consumed = 2;
    } else if (flag === "attach") {
      const path = readOptionValue(args, i, "Error: --attach requires a file path");
      attachments.push({ path: resolve(path) });
      consumed = 2;
    } else if (flag === "style") {
      promptStyle = parsePromptStyle(readOptionValue(args, i, "Error: --style requires a value"));
      consumed = 2;
    } else if (flag === "model") {
      model = readOptionValue(args, i, "Error: --model requires a value");
      consumed = 2;
    } else if (flag === "effort") {
      effort = parseEffortValue(args, i);
      consumed = 2;
    } else if (flag === "harness") {
      // Consumed by extractHarnessFlags() before parseArgs() runs; the value
      // is validated exactly once in main(). Skip here to avoid treating it
      // as an unknown argument.
      readOptionValue(args, i, "Error: --harness requires a value");
      consumed = 2;
    } else if (flag === "decompose") {
      decompose = true;
    } else if (flag === "confirm") {
      confirm = true;
    } else if (flag === "verbose") {
      // Handled before parseArgs() is called; skip here
    } else if (flag === "no-update" || flag === "version") {
      // Handled before parseArgs() / inside maybeOfferCliUpdate; skip here
    } else if (flag === "yes" || flag === "no-interactive") {
      // Init-only flags; ignored outside init (init returns early above).
    } else {
      console.error(`Error: Unknown argument "${arg}"`);
      console.error("Use --help to see available options");
      process.exit(1);
    }

    i += consumed;
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
    effort,
    issueType,
    extraInstructions: customInstructions,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/**
 * Parse the value following an `--effort` flag at `index` in raw argv.
 *
 * Shared by the {@link parseArgs} loop and the `serve` branch in `index.ts`
 * so both surfaces behave identically: `--effort` as the last argument is an
 * error rather than a silent no-op, and an invalid value fails with the
 * accepted levels.
 *
 * @param args - Raw argv slice.
 * @param index - Index of the `--effort` flag within `args`.
 * @returns The validated effort, or `undefined` when the value is blank.
 */
export function parseEffortValue(args: string[], index: number): AgentEffort | undefined {
  if (index + 1 >= args.length) {
    console.error("Error: --effort requires a value (low, medium, or high)");
    process.exit(1);
  }
  try {
    return parseAgentEffort(args[index + 1]);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
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
