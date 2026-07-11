#!/usr/bin/env bun

/**
 * CLI utility to create tasks from Figma designs, logs, or prompts
 * and store them in Jira, Linear, Markdown files, or other backends.
 */

import { join } from "node:path";
import { loadConfig, loadSupabaseConfig, migrateLegacyConfigDir } from "./lib/config";
import { createBackend } from "./lib/backends";
import type { TaskBackend } from "./lib/backends";
import { runAgent } from "./lib/agent";
import { dumpAgentOutput } from "./lib/agent-debug";
import { parseAgentJson } from "./lib/agent-json";
import { runInteractiveMode } from "./lib/components/interactive";
import { initializeProject } from "./lib/init";
import { getAuthenticatedUser, login, logout, resolveLogin } from "@devintern/auth";

/**
 * Load a prompt template from file and replace placeholders.
 *
 * @param sourceType - Source category (`figma`, `log`, or `prompt`) used to locate the template.
 * @param style - Prompt style subdirectory (`technical` or `pm`).
 * @param filename - Template filename within the style directory.
 * @param replacements - Placeholder keys (without braces) mapped to replacement values.
 * @returns The trimmed prompt text with all `{{key}}` placeholders substituted.
 */
async function loadPrompt(
  sourceType: SourceType,
  style: "technical" | "pm",
  filename: string,
  replacements: Record<string, string>,
): Promise<string> {
  // Detect if we're running from dist/ (bundled) or from source
  const isBundle = import.meta.dir.endsWith("/dist") || import.meta.dir.endsWith("\\dist");
  const baseDir = isBundle ? join(import.meta.dir, "..") : import.meta.dir;

  const promptPath = join(baseDir, "prompts", sourceType, style, filename);
  const promptFile = Bun.file(promptPath);
  let prompt = await promptFile.text();

  // Replace all placeholders
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), value);
  }

  return prompt.trim();
}

/**
 * Ask the user for yes/no confirmation on stdin.
 *
 * @param message - Prompt text displayed before `(Y/n)`.
 * @returns `true` for yes (including empty input), `false` for no or on read error.
 */
async function askConfirm(message: string): Promise<boolean> {
  while (true) {
    process.stdout.write(`${message} (Y/n): `);

    try {
      // Use Bun's synchronous readline-like approach
      const proc = Bun.spawn(["bash", "-c", 'read line && echo "$line"'], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "inherit",
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const answer = output.trim().toLowerCase();

      // Empty input (just Enter) defaults to yes
      if (answer === "" || answer === "y" || answer === "yes") {
        return true;
      } else if (answer === "n" || answer === "no") {
        return false;
      } else {
        // Invalid input, loop and prompt again
        process.stdout.write(`Please answer 'y' or 'n' (default: y): `);
        continue;
      }
    } catch (error) {
      console.error("\nError reading input:", error);
      return false;
    }
  }
}

type SourceType = "figma" | "log" | "prompt";

interface SourceInput {
  type: SourceType;
  content: string;
}

interface CLIArgs {
  source: SourceInput;
  epicKey?: string;
  extraInstructions?: string;
  promptStyle: "technical" | "pm";
  decompose: boolean;
  confirm: boolean;
  model?: string;
  issueType: string;
}

interface StoryPayload {
  summary: string;
  description: string;
}

interface SubtaskPayload {
  summary: string;
  description?: string;
}

interface DecompositionPayload {
  subtasks: SubtaskPayload[];
}

/**
 * Parse CLI arguments from `Bun.argv`.
 *
 * @returns Parsed task-creation args, `null` for interactive mode, a command sentinel
 *   (`init`, `login`, `logout`, `whoami`), or exits the process on `--help`/validation errors.
 */
function parseArgs(): CLIArgs | null | "init" | "login" | "logout" | "whoami" {
  const args = Bun.argv.slice(2);

  // Check for init command early
  if (args.includes("init") || args.includes("--init")) {
    return "init"; // Signal to run init
  }
  if (args.includes("login")) {
    return "login";
  }
  if (args.includes("logout")) {
    return "logout";
  }
  if (args.includes("whoami")) {
    return "whoami";
  }

  // Check for interactive mode early
  if (args.includes("--interactive")) {
    return null; // Signal to use interactive mode
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: devpm init
       devpm login [method|email]
       devpm logout
       devpm whoami
       devpm --figma <url> [options]
       devpm --log <text> [options]
       devpm --prompt <text> [options]
       devpm --interactive

Commands:
  init                 Initialize .devintern-pm configuration in current directory
  login [method]       Sign in (github | google | x | email; prompts if omitted)
  logout               Clear local auth session
  whoami               Show current authenticated user

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

Examples:
  # Interactive mode (recommended)
  devpm --interactive            # Step-by-step task creation

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
    } else if (arg === "--decompose") {
      decompose = true;
    } else if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--verbose" || arg === "-v") {
      // Handled before parseArgs() is called; skip here
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

/** Extract the last non-empty line from an agent stderr chunk for status display. */
function lastStderrLine(chunk: string): string | undefined {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1);
}

/**
 * Show an interactive-mode error and wait for the user to restart the wizard.
 *
 * @param handle - Active interactive mode handle.
 * @param message - Error text shown on the success/error screen.
 */
async function showInteractiveErrorAndRestart(
  handle: Awaited<ReturnType<typeof runInteractiveMode>>,
  message: string,
): Promise<void> {
  handle.showSuccess(message);
  await handle.waitForRestart();
  handle.restart();
}

/**
 * CLI entry point: routes commands, runs interactive or batch task creation,
 * and orchestrates agent prompts with the configured task backend.
 *
 * @returns A promise that resolves when the command completes; may recurse in interactive mode.
 */
async function main() {
  // Enable verbose API logging globally when --verbose or -v is passed
  const args = Bun.argv.slice(2);
  if (args.includes("--verbose") || args.includes("-v")) {
    process.env.DEVINTERN_VERBOSE = "1";
  }

  // Migrate legacy .claude-pm directory to .devintern-pm if needed
  await migrateLegacyConfigDir();

  // Parse arguments - null means interactive mode, 'init' means run initialization
  const parsedArgs = parseArgs();

  // Handle init command
  if (parsedArgs === "init") {
    await initializeProject();
    return;
  }
  if (parsedArgs === "login") {
    try {
      const supabaseConfig = await loadSupabaseConfig();
      const resolved = await resolveLogin(Bun.argv);
      const user = await login(supabaseConfig, resolved);
      console.log(`✅ Signed in as ${user.email || user.id}`);
      process.exit(0);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      process.exit(1);
    }
  }
  if (parsedArgs === "logout") {
    const supabaseConfig = await loadSupabaseConfig();
    await logout(supabaseConfig);
    console.log("✅ Signed out");
    return;
  }
  if (parsedArgs === "whoami") {
    const supabaseConfig = await loadSupabaseConfig();
    const user = await getAuthenticatedUser(supabaseConfig);
    if (!user) {
      console.log("Not signed in. Run `devpm login`.");
      return;
    }
    console.log(`Signed in as ${user.email || user.id}`);
    return;
  }

  let source: SourceInput;
  let epicKey: string | undefined;
  let extraInstructions: string | undefined;
  let promptStyle: "technical" | "pm";
  let decompose: boolean;
  let confirm: boolean;
  let model: string | undefined;
  let issueType: string;
  let projectKey: string | undefined;
  let interactiveHandle: Awaited<ReturnType<typeof runInteractiveMode>> | null = null;
  let configForInteractive: Awaited<ReturnType<typeof loadConfig>> | undefined;

  try {
    // Load config early for all operational modes. Interactive use is free
    // under FSL, so pm performs no license check.
    configForInteractive = await loadConfig();

    if (parsedArgs === null) {
      // Interactive mode with preview - setup once
      console.clear();

      const backend = await createBackend(configForInteractive);

      // Fetch projects user has access to
      let projectsData: Array<{ key: string; name: string }> | undefined;
      try {
        if (backend.getProjects) {
          const projects = await backend.getProjects();
          projectsData = projects.map((p) => ({ key: p.key, name: p.name }));
        }
      } catch {
        console.error(`⚠️  Warning: Could not fetch projects from ${backend.name}`);
      }

      // Determine which project to use for fetching issue types.
      // Prefer the configured default key, but if projectsData is available and the key isn't in
      // it (e.g. misconfigured or no access), fall back to the first accessible project.
      const configuredKey =
        configForInteractive.jira?.defaultProjectKey ||
        configForInteractive.linear?.defaultTeamKey ||
        configForInteractive.trello?.defaultBoardId ||
        configForInteractive.azureDevOps?.defaultProject ||
        configForInteractive.asana?.defaultProjectGid ||
        configForInteractive.github?.repository;
      const firstProjectKey =
        projectsData && projectsData.length > 0 ? projectsData[0]?.key : undefined;
      const projectKeyForIssueTypes =
        configuredKey && (!projectsData || projectsData.some((p) => p.key === configuredKey))
          ? configuredKey
          : (firstProjectKey ?? configuredKey);

      // Fetch issue types from backend for the default project (initial load).
      // Only fetch if the backend actually supports issue type selection.
      let issueTypeNames: string[] | undefined;
      if (backend.supportsIssueTypes) {
        try {
          if (backend.getIssueTypes) {
            const issueTypesData = await backend.getIssueTypes(projectKeyForIssueTypes);
            issueTypeNames = issueTypesData;
          }
        } catch (err) {
          // Fetch failed — fall back to defaults so undefined unambiguously means "not supported"
          const reason = err instanceof Error ? err.message : String(err);
          const hint =
            projectsData !== undefined && projectsData.length === 0
              ? " — your API user has no project access; add them to the project in your tracker's settings"
              : "";
          console.error(
            `⚠️  Warning: Could not fetch issue types from ${backend.name}, using defaults (${reason}${hint})`,
          );
          issueTypeNames = ["Task", "Story", "Bug", "Epic"];
        }
        // If getIssueTypes is not defined on a supporting backend, use defaults
        if (!issueTypeNames) {
          issueTypeNames = ["Task", "Story", "Bug", "Epic"];
        }
      }

      try {
        interactiveHandle = await runInteractiveMode({
          projects: projectsData,
          defaultProjectKey:
            configForInteractive.jira?.defaultProjectKey ||
            configForInteractive.linear?.defaultTeamKey ||
            configForInteractive.trello?.defaultBoardId ||
            configForInteractive.azureDevOps?.defaultProject ||
            configForInteractive.asana?.defaultProjectGid ||
            (configForInteractive.github ? configForInteractive.github.repository : undefined),
          issueTypes: issueTypeNames,
          fetchIssueTypes:
            backend.supportsIssueTypes && backend.getIssueTypes
              ? async (projectKey: string) => {
                  const types = await backend.getIssueTypes!(projectKey);
                  return types;
                }
              : undefined,
          backendName: backend.name,
          harnessDisplayName: configForInteractive.agent.harness.displayName,
          supportsEpicLinking: backend.supportsEpicLinking,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Interactive mode cancelled") {
          console.log("\nBye!");
          process.exit(0);
        }
        console.error(
          "\n❌ Interactive mode failed:",
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }

      // Get initial config (before preview)
      const interactiveConfig = await interactiveHandle.waitForCompletion();

      // Convert interactive config to CLI args format
      if (!interactiveConfig.sourceType || !interactiveConfig.sourceContent) {
        console.error("❌ Interactive mode was cancelled or incomplete");
        process.exit(1);
      }

      source = {
        type: interactiveConfig.sourceType,
        content: interactiveConfig.sourceContent,
      };
      epicKey = interactiveConfig.epicKey;
      extraInstructions = interactiveConfig.customInstructions;
      promptStyle = interactiveConfig.promptStyle;
      decompose = interactiveConfig.decompose;
      confirm = false; // Interactive mode handles confirmation differently
      model = undefined;
      issueType = interactiveConfig.issueType;
      projectKey = interactiveConfig.projectKey;
    } else {
      // CLI mode
      source = parsedArgs.source;
      epicKey = parsedArgs.epicKey;
      extraInstructions = parsedArgs.extraInstructions;
      promptStyle = parsedArgs.promptStyle;
      decompose = parsedArgs.decompose;
      confirm = parsedArgs.confirm;
      model = parsedArgs.model;
      issueType = parsedArgs.issueType;
      projectKey = undefined; // CLI mode uses default project
    }

    // Config already loaded and verified early; reuse for both modes
    const config = configForInteractive!;

    // Initialize task backend
    const backend = await createBackend(config);

    // Step 1: Run Agent to create story from source
    const sourceTypeLabel =
      source.type === "figma"
        ? "Figma design"
        : source.type === "log"
          ? "error log"
          : "free-form prompt";
    if (!interactiveHandle) {
      console.log(`Step 1: Creating ${backend.name} story from ${sourceTypeLabel}\n`);
      console.log(`Source type: ${source.type}`);
      if (source.type === "figma") {
        console.log(`Figma URL: ${source.content}`);
      } else {
        // Show first 100 chars of content
        const preview =
          source.content.length > 100 ? source.content.substring(0, 100) + "..." : source.content;
        const label = source.type === "log" ? "Log preview" : "Prompt preview";
        console.log(`${label}: ${preview}`);
      }
      console.log(`Prompt style: ${promptStyle}`);
      console.log(`Issue type: ${issueType}`);
      if (model) {
        console.log(`Model: ${model}`);
      }
      if (epicKey) {
        console.log(`Epic: ${epicKey}`);
      }
      if (extraInstructions) {
        console.log(`Custom instructions: ${extraInstructions}`);
      }
    }

    // Prepare replacements based on source type
    const replacements: Record<string, string> = {
      epicContext: epicKey ? `\nThis story will be part of epic: ${epicKey}` : "",
      extraInstructions: extraInstructions ? `\nAdditional instructions: ${extraInstructions}` : "",
    };

    if (source.type === "figma") {
      replacements.figmaUrl = source.content;
    } else if (source.type === "log") {
      replacements.logContent = source.content;
    } else if (source.type === "prompt") {
      replacements.promptContent = source.content;
    }

    const storyPrompt = await loadPrompt(
      source.type,
      promptStyle,
      "story-generation.txt",
      replacements,
    );

    // In interactive mode, show generating state
    const interactiveUi = interactiveHandle;
    if (interactiveUi) {
      interactiveUi.setGenerating();
    }

    const storyResult = await runAgent(config.agent.harness, config.agent.path, storyPrompt, {
      maxTurns: 100,
      skipPermissions: true,
      model,
      silent: !!interactiveUi,
      onStderr: interactiveUi
        ? (chunk) => {
            const line = lastStderrLine(chunk);
            if (line) {
              interactiveUi.setStatusMessage(line);
            }
          }
        : undefined,
    });

    if (storyResult.exitCode !== 0) {
      const errorDetail = storyResult.stderr.trim() || "Unknown agent error";
      const dumpFile = await dumpAgentOutput("story-generation", storyResult, {
        harness: config.agent.harness.name,
        cliPath: config.agent.path,
      });
      const dumpHint = dumpFile ? `\nFull agent output: ${dumpFile}` : "";
      if (interactiveHandle) {
        await showInteractiveErrorAndRestart(
          interactiveHandle,
          `Error: Failed to analyze ${sourceTypeLabel}\n${errorDetail}${dumpHint}`,
        );
        return main();
      }
      console.error(`❌ Failed to analyze ${sourceTypeLabel}`);
      console.error(storyResult.stderr);
      if (dumpFile) {
        console.error(`Full agent output: ${dumpFile}`);
      }
      process.exit(1);
    }

    // Parse JSON from Agent output (may be fenced or prefixed with prose)
    let storyData: StoryPayload;
    try {
      storyData = parseAgentJson<StoryPayload>(storyResult.stdout);

      if (!storyData.summary || !storyData.description) {
        throw new Error("Missing required fields: summary and description");
      }
    } catch (error) {
      const parseError = error instanceof Error ? error.message : String(error);
      const dumpFile = await dumpAgentOutput("story-generation-parse", storyResult, {
        harness: config.agent.harness.name,
        cliPath: config.agent.path,
      });
      const dumpHint = dumpFile ? `\nFull agent output: ${dumpFile}` : "";
      if (interactiveHandle) {
        await showInteractiveErrorAndRestart(
          interactiveHandle,
          `Error: Failed to parse story from agent output\n${parseError}${dumpHint}`,
        );
        return main();
      }
      console.error("\n❌ Failed to parse story requirements from Agent output");
      console.error("Error:", parseError);
      console.error("Output:", storyResult.stdout);
      if (dumpFile) {
        console.error(`Full agent output (incl. stderr): ${dumpFile}`);
      }
      process.exit(1);
    }

    // In interactive mode, show preview and wait for confirmation or edits
    if (interactiveHandle) {
      const ui = interactiveHandle;
      ui.setPreviewData(storyData.summary, storyData.description);

      // Edit loop - allow user to request edits multiple times
      while (true) {
        const editRequest = await Promise.race([
          ui.waitForCompletion().then(() => null),
          ui.waitForEdit(),
        ]);

        if (!editRequest) {
          // User confirmed, break out of edit loop
          break;
        }

        // User requested an edit
        const editPrompt = `You are helping revise a ${issueType.toLowerCase()} description.

Current Title: ${editRequest.currentSummary}

Current Description:
${editRequest.currentDescription}

User's edit request: ${editRequest.editPrompt}

Please update the description based on the user's feedback. Keep the same title unless the user specifically asks to change it. Return ONLY valid JSON in this exact format:

\`\`\`json
{
  "summary": "Updated or same title",
  "description": "Updated description in markdown format"
}
\`\`\``;

        ui.setStatusMessage("Updating task description...");

        const editResult = await runAgent(config.agent.harness, config.agent.path, editPrompt, {
          maxTurns: 100,
          skipPermissions: true,
          model,
          silent: true,
          onStderr: (chunk) => {
            const line = lastStderrLine(chunk);
            if (line) {
              ui.setStatusMessage(line);
            }
          },
        });

        if (editResult.exitCode !== 0) {
          const errorDetail = editResult.stderr.trim() || "Unknown agent error";
          ui.setStatusMessage(`Update failed: ${errorDetail}`);
          continue;
        }

        // Parse updated JSON
        try {
          const updatedData = parseAgentJson<StoryPayload>(editResult.stdout);

          if (!updatedData.summary || !updatedData.description) {
            throw new Error("Missing required fields in update");
          }

          // Update storyData with the new content
          storyData = updatedData;

          // Show updated preview
          ui.setPreviewData(storyData.summary, storyData.description);
        } catch (error) {
          console.error("❌ Failed to parse updated task from Agent");
          console.error("Error:", error instanceof Error ? error.message : error);
          const dumpFile = await dumpAgentOutput("story-edit-parse", editResult, {
            harness: config.agent.harness.name,
            cliPath: config.agent.path,
          });
          if (dumpFile) {
            ui.setStatusMessage(`Update failed to parse — full agent output: ${dumpFile}`);
          }
          // Loop will retry
        }
      }
    }

    if (!interactiveHandle) {
      console.log(`\n📝 Creating ${backend.name} ${issueType.toLowerCase()}...`);
      console.log(`   Title: ${storyData.summary}`);
    }

    // Create the task via backend
    const createdTask = await backend.createTask(
      storyData.summary,
      storyData.description,
      issueType,
      projectKey,
    );

    if (!interactiveHandle) {
      console.log(`\n✅ ${backend.name} ${issueType.toLowerCase()} created: ${createdTask.url}`);
    }

    // Link to epic if provided and the tracker can persist a real link.
    // Trackers without epic support (e.g. Trello, GitHub, Markdown) skip this
    // silently so we never create a misleading attachment/text reference.
    if (epicKey && backend.supportsEpicLinking && backend.linkToEpic) {
      if (!interactiveHandle) {
        console.log(`🔗 Linking story to epic ${epicKey}...`);
      }
      try {
        await backend.linkToEpic(createdTask.key, epicKey);
        if (!interactiveHandle) {
          console.log(`✅ Story linked to epic ${epicKey}`);
        }
      } catch (error) {
        console.error(
          `⚠️  Warning: Failed to link to epic: ${error instanceof Error ? error.message : error}`,
        );
        if (!interactiveHandle) {
          console.log("Continuing with task decomposition...");
        }
      }
    }
    if (!interactiveHandle) {
      console.log();
    }

    // Check if we should decompose into subtasks
    if (!decompose) {
      if (!interactiveHandle) {
        console.log(`✅ ${issueType} created successfully!\n`);
        console.log("Summary:");
        console.log(`  ${issueType}: ${createdTask.url}`);
        if (epicKey) {
          console.log(`  Epic: ${epicKey}`);
        }
        console.log("\n🎉 Done!");
      }

      // In interactive mode, show success and wait for user to restart
      if (interactiveHandle) {
        interactiveHandle.showSuccess(`Task created: ${createdTask.url}`);
        // Wait for user key press to restart
        await interactiveHandle.waitForRestart();
        // Restart the flow
        return main();
      }
      return;
    }

    // Step 2: Run Agent to decompose the story into tasks
    console.log("Step 2: Decomposing story into tasks\n");

    const decomposePrompt = await loadPrompt(source.type, promptStyle, "decomposition.txt", {
      storySummary: storyData.summary,
      storyDescription: storyData.description,
    });

    const decomposeResult = await runAgent(
      config.agent.harness,
      config.agent.path,
      decomposePrompt,
      {
        maxTurns: 100,
        skipPermissions: true,
        model,
      },
    );

    if (decomposeResult.exitCode !== 0) {
      console.error("❌ Failed to decompose story");
      console.error(decomposeResult.stderr);
      process.exit(1);
    }

    // Parse subtasks JSON from Agent output
    let subtasksData: DecompositionPayload;
    try {
      subtasksData = parseAgentJson<DecompositionPayload>(decomposeResult.stdout);

      if (!subtasksData.subtasks || !Array.isArray(subtasksData.subtasks)) {
        throw new Error("Expected subtasks array in response");
      }
    } catch (error) {
      console.error("\n❌ Failed to parse subtasks from Agent output");
      console.error("Error:", error instanceof Error ? error.message : error);
      console.error("Output:", decomposeResult.stdout);
      const dumpFile = await dumpAgentOutput("decomposition-parse", decomposeResult, {
        harness: config.agent.harness.name,
        cliPath: config.agent.path,
      });
      if (dumpFile) {
        console.error(`Full agent output (incl. stderr): ${dumpFile}`);
      }
      process.exit(1);
    }

    console.log(`\n✅ Agent suggested ${subtasksData.subtasks.length} subtasks\n`);

    if (confirm) {
      console.log("📝 Review and confirm each subtask:\n");
    } else {
      console.log(`📝 Creating subtasks in ${backend.name}...\n`);
    }

    // Create each subtask via API
    const createdSubtasks = [];
    const skippedSubtasks = [];

    for (let i = 0; i < subtasksData.subtasks.length; i++) {
      const subtask = subtasksData.subtasks[i];
      if (!subtask) continue;

      // If confirmation mode is enabled, ask user
      if (confirm) {
        // Visual separator between tasks
        console.log("\n" + "─".repeat(80));
        console.log(`\n📋 Task ${i + 1}/${subtasksData.subtasks.length}`);
        console.log(`   ${subtask.summary}\n`);

        if (subtask.description) {
          // Show first 300 characters of description with better formatting
          const descPreview = subtask.description.substring(0, 300);
          // Split into lines and indent each line
          const lines = descPreview.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              console.log(`   ${line}`);
            }
          }
          if (subtask.description.length > 300) {
            console.log("   ...");
          }
          console.log(""); // Extra blank line
        }

        const shouldCreate = await askConfirm(`Create this subtask?`);
        if (!shouldCreate) {
          skippedSubtasks.push(subtask.summary);
          console.log(`⏭️  Skipped\n`);
          continue;
        }
      }

      try {
        // Ensure we have a description, use summary as fallback
        const description = subtask.description?.trim() || subtask.summary;

        const created = await backend.createSubtask(
          createdTask.key,
          subtask.summary,
          description,
          projectKey,
        );
        createdSubtasks.push(created);
        if (confirm) {
          console.log(`✅ Created: ${created.key}\n`);
        } else {
          console.log(`   ✅ ${created.key}: ${subtask.summary}`);
        }
      } catch (error) {
        if (confirm) {
          console.error(`⚠️  Failed to create subtask: ${subtask.summary}`);
          console.error(`   Error: ${error instanceof Error ? error.message : error}\n`);
        } else {
          console.error(`   ⚠️  Failed to create subtask: ${subtask.summary}`);
          console.error(`      Error: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    console.log(`\n✅ ${issueType} decomposed into tasks successfully!\n`);
    console.log("Summary:");
    console.log(`  ${issueType}: ${createdTask.url}`);
    console.log(`  Created: ${createdSubtasks.length} subtasks`);
    if (skippedSubtasks.length > 0) {
      console.log(`  Skipped: ${skippedSubtasks.length} subtasks`);
    }
    if (epicKey) {
      console.log(`  Epic: ${epicKey}`);
    }
    console.log("\n🎉 Done!");

    // In interactive mode, show success and wait for user to restart
    if (interactiveHandle) {
      interactiveHandle.showSuccess(`Task created: ${createdTask.url}`);
      // Wait for user key press to restart
      await interactiveHandle.waitForRestart();
      // Restart the flow
      return main();
    }
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : error);
    // In interactive mode, show error and wait for user to restart
    if (interactiveHandle) {
      interactiveHandle.showSuccess(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      // Wait for user key press to restart
      await interactiveHandle.waitForRestart();
      return main();
    }
    process.exit(1);
  }
}

// Run CLI mode
main();
