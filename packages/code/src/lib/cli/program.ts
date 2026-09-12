import { Command, Option } from "commander";
import { VERSION } from "./bootstrap";
import { HELP_EXAMPLES } from "./help";

/** Parsed `devintern` CLI flags (the non-subcommand task-run mode). */
export interface ProgramOptions {
  claudePath: string;
  agentPath: string;
  envFile?: string;
  git: boolean;
  verbose: boolean;
  maxTurns: string;
  autoCommit: boolean;
  skipClarityCheck: boolean; // New option to skip clarity check
  createPr: boolean; // New option to create pull request
  prTargetBranch: string; // Target branch for PR
  prTargetBranchExplicit?: boolean; // Whether --pr-target-branch was supplied
  requestedPrTargetBranch?: string; // Unresolved explicit target for provider validation
  autoReview: boolean; // New option to run automatic PR review loop
  autoReviewIterations?: string; // Max iterations for auto-review loop (unset → AUTO_REVIEW_ITERATIONS env or shared default)
  query?: string; // Generic query for batch processing
  jql?: string; // Deprecated alias for --query
  skipComments: boolean; // Skip posting comments to task tracker
  force: boolean; // Bypass the retry gate (re-run an unchanged incomplete task)
  skipJiraComments: boolean; // Deprecated alias for --skip-comments
  hookRetries: string; // Number of retries for git hook failures
  estimate: boolean; // Run in estimation mode to add story points
  sandbox?: string; // Sandbox provider for the agent process
}

const SUBCOMMANDS = [
  "init",
  "worker",
  "dashboard",
  "workspace",
  "webhook",
  "address-review",
  "resolve-conflicts",
  "login",
  "logout",
  "whoami",
  "sandbox",
  "doctor",
] as const;

/** Whether `command` is handled by the pre-Commander subcommand dispatch. */
export function isSubcommandCommand(command: string | undefined): boolean {
  return (SUBCOMMANDS as readonly string[]).includes(command ?? "");
}

/** Build the Commander program (options, task-key argument, and help text). */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("devintern")
    .description(
      "Your AI intern for automatically implementing tasks using Agent Harness. Supports single tasks, multiple tasks, or query-based batch processing.",
    )
    .version(VERSION)
    .argument(
      "[task-keys...]",
      "One or more task keys (Jira: PROJ-123; Linear: ENG-42 or issue URL; GitHub: 123, #123, or issue URL; Trello: card short link, full card URL, or 24-char ID), local markdown file paths (./task.md), or use --query for batch selection",
    )
    .option(
      "--query <query>",
      'Query to fetch multiple tasks (syntax depends on tracker; Jira: JQL, e.g., "project = PROJ AND status = \'To Do\'"; Linear: JSON IssueFilter or plain text; GitHub: search qualifiers, e.g., "is:open label:bug")',
    )
    .addOption(new Option("--jql <query>", "JQL query to fetch multiple Jira issues").hideHelp())
    .option("--agent-path <path>", "Path to the AI agent CLI executable")
    .addOption(new Option("--claude-path <path>", "Path to Claude CLI executable").hideHelp())
    .option("--env-file <path>", "Path to .env file")
    .option("--no-git", "Skip git branch creation")
    .option("-v, --verbose", "Verbose output")
    .option("--max-turns <number>", "Maximum number of turns for Agent", "500")
    .option("--no-auto-commit", "Skip automatic git commit after Agent completes")
    .option("--skip-clarity-check", "Skip running Agent for clarity assessment")
    .option("--create-pr", "Create pull request after implementation")
    .option(
      "--pr-target-branch <branch>",
      "Target branch for pull request (omitting this uses the repository default branch)",
      "main",
    )
    .option(
      "--auto-review",
      "Run automatic PR review loop after creating PR (requires --create-pr)",
    )
    .option(
      "--auto-review-iterations <number>",
      "Maximum review-fix cycles for auto-review (default: 2; env: AUTO_REVIEW_ITERATIONS)",
    )
    .option("--skip-comments", "Skip posting comments to the task tracker (for testing)")
    .option(
      "--force",
      "Re-run a task even if a previous attempt was reported incomplete and the ticket is unchanged",
    )
    .addOption(new Option("--skip-jira-comments", "Skip posting comments to JIRA").hideHelp())
    .option("--hook-retries <number>", "Number of retry attempts for git hook failures", "10")
    .option(
      "--estimate",
      "Run in estimation mode to add story points estimates to tasks (Jira, Linear, Azure DevOps, Asana via custom field; GitHub and GitLab post comment-only estimates)",
    )
    .option(
      "--sandbox <provider>",
      "Run the agent inside a sandbox: none | auto | native | nono | srt | docker | smolvm (overrides AGENT_SANDBOX; run 'devintern sandbox' to see what is available)",
    )
    .addOption(new Option("--no-update", "Skip the npm update check for this run"));

  program.addHelpText("after", HELP_EXAMPLES);

  return program;
}
