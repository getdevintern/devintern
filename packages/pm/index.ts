#!/usr/bin/env node

/**
 * CLI utility to create tasks from Figma designs, logs, or prompts
 * and store them in Jira, Linear, Markdown files, or other backends.
 */

import { askConfirm } from "./lib/runtime/stdin.js";
import { getArgs } from "./lib/runtime/args.js";
import { configureTerminalEncoding } from "./lib/runtime/terminal.js";
import { loadConfig, migrateLegacyConfigDir } from "./lib/config";
import {
  createEngine,
  EngineError,
  type PmEngine,
  type SourceInput,
  type StoryDraft,
} from "./lib/engine";
import { runInteractiveMode } from "./lib/components/interactive";
import { initializeProject } from "./lib/init";
import { isInteractive, runPmInitWizard } from "./lib/init-wizard";

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

/**
 * Parse CLI arguments from `process.argv`.
 *
 * @returns Parsed task-creation args, `null` for interactive mode, a command sentinel
 *   (`init`), or exits the process on `--help`/validation errors.
 */
function parseArgs(): CLIArgs | null | "init" {
  const args = getArgs();

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
 * Show an interactive-mode error/success screen, wait for a key, then reset the wizard
 * in-place (no remount) so create-another never leaves a blank terminal.
 *
 * @param handle - Active interactive mode handle.
 * @param message - Error or status text shown on the success screen.
 * @throws If the user cancels with Ctrl+C while waiting.
 */
async function showInteractiveMessageAndRestart(
  handle: Awaited<ReturnType<typeof runInteractiveMode>>,
  message: string,
): Promise<void> {
  handle.showSuccess(message);
  await handle.waitForRestart();
  handle.restart();
}

/** True when an interactive waiter rejected because the user cancelled (Ctrl+C / unmount). */
function isInteractiveCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === "Interactive mode cancelled";
}

/**
 * CLI entry point: routes commands, runs interactive or batch task creation,
 * and orchestrates agent prompts with the configured task backend.
 *
 * Interactive mode reuses a single Ink session across create-another cycles
 * (success → keypress → wizard start) instead of remounting via recursive main().
 *
 * @returns A promise that resolves when the command completes.
 */
async function main() {
  configureTerminalEncoding();

  // Enable verbose API logging globally when --verbose or -v is passed
  const args = getArgs();
  if (args.includes("--verbose") || args.includes("-v")) {
    process.env.DEVINTERN_VERBOSE = "1";
  }

  // Migrate legacy .claude-pm directory to .devintern-pm if needed
  await migrateLegacyConfigDir();

  // Parse arguments - null means interactive mode, 'init' means run initialization
  const parsedArgs = parseArgs();

  // Handle init command: guided wizard in interactive terminals, template
  // scaffold with `--yes` / `--no-interactive` / piped stdin.
  if (parsedArgs === "init") {
    if (isInteractive(process.argv, process.stdin)) {
      await runPmInitWizard();
    } else {
      await initializeProject();
    }
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

    const engine: PmEngine = await createEngine(configForInteractive, {
      model: parsedArgs?.model,
    });

    if (parsedArgs === null) {
      // Interactive mode with preview - setup once
      console.clear();

      // Fetch projects user has access to
      let projectsData: Array<{ key: string; name: string }> | undefined;
      try {
        projectsData = await engine.listProjects();
      } catch {
        console.error(`⚠️  Warning: Could not fetch projects from ${engine.backendName}`);
      }

      // Determine which project to use for fetching issue types.
      // Prefer the configured default key, but if projectsData is available and the key isn't in
      // it (e.g. misconfigured or no access), fall back to the first accessible project.
      const configuredKey = engine.defaultProjectKey;
      const firstProjectKey =
        projectsData && projectsData.length > 0 ? projectsData[0]?.key : undefined;
      const projectKeyForIssueTypes =
        configuredKey && (!projectsData || projectsData.some((p) => p.key === configuredKey))
          ? configuredKey
          : (firstProjectKey ?? configuredKey);

      // Fetch issue types from backend for the default project (initial load).
      // Only fetch if the backend actually supports issue type selection.
      let issueTypeNames: string[] | undefined;
      if (engine.supportsIssueTypes) {
        try {
          issueTypeNames = await engine.listIssueTypes(projectKeyForIssueTypes);
        } catch (err) {
          // Fetch failed — fall back to defaults so undefined unambiguously means "not supported"
          const reason = err instanceof Error ? err.message : String(err);
          const hint =
            projectsData !== undefined && projectsData.length === 0
              ? " — your API user has no project access; add them to the project in your tracker's settings"
              : "";
          console.error(
            `⚠️  Warning: Could not fetch issue types from ${engine.backendName}, using defaults (${reason}${hint})`,
          );
          issueTypeNames = ["Task", "Story", "Bug", "Epic"];
        }
      }

      try {
        interactiveHandle = await runInteractiveMode({
          projects: projectsData,
          defaultProjectKey: engine.defaultProjectKey,
          issueTypes: issueTypeNames,
          fetchIssueTypes: engine.supportsIssueTypes
            ? (projectKey: string) => engine.listIssueTypes(projectKey)
            : undefined,
          backendName: engine.backendName,
          harnessDisplayName: configForInteractive.agent.harness.displayName,
          supportsEpicLinking: engine.supportsEpicLinking,
        });
      } catch (error) {
        if (isInteractiveCancelled(error)) {
          console.log("\nBye!");
          process.exit(0);
        }
        console.error(
          "\n❌ Interactive mode failed:",
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }

      // Create-another loop: reuse the same Ink session. Remounting via main()
      // previously left a blank screen (old instance not cleaned up + console.clear).
      const config = configForInteractive;

      while (true) {
        let interactiveConfig;
        try {
          interactiveConfig = await interactiveHandle.waitForCompletion();
        } catch (error) {
          if (isInteractiveCancelled(error)) {
            interactiveHandle.cleanup();
            console.log("\nBye!");
            process.exit(0);
          }
          throw error;
        }

        if (!interactiveConfig.sourceType || !interactiveConfig.sourceContent) {
          console.error("❌ Interactive mode was cancelled or incomplete");
          interactiveHandle.cleanup();
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

        const shouldContinue = await runCreateFlow({
          source,
          epicKey,
          extraInstructions,
          promptStyle,
          decompose,
          confirm,
          model,
          issueType,
          projectKey,
          interactiveHandle,
          config,
          engine,
        });

        if (!shouldContinue) {
          interactiveHandle.cleanup();
          return;
        }
        // handle.restart() already ran inside runCreateFlow; loop for next task
      }
    }

    // CLI mode (one-shot)
    source = parsedArgs.source;
    epicKey = parsedArgs.epicKey;
    extraInstructions = parsedArgs.extraInstructions;
    promptStyle = parsedArgs.promptStyle;
    decompose = parsedArgs.decompose;
    confirm = parsedArgs.confirm;
    model = parsedArgs.model;
    issueType = parsedArgs.issueType;
    projectKey = undefined; // CLI mode uses default project

    // Config already loaded and verified early
    const config = configForInteractive!;

    await runCreateFlow({
      source,
      epicKey,
      extraInstructions,
      promptStyle,
      decompose,
      confirm,
      model,
      issueType,
      projectKey,
      interactiveHandle: null,
      config,
      engine,
    });
  } catch (error) {
    if (isInteractiveCancelled(error)) {
      interactiveHandle?.cleanup();
      console.log("\nBye!");
      process.exit(0);
    }
    console.error("\n❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

interface CreateFlowParams {
  source: SourceInput;
  epicKey?: string;
  extraInstructions?: string;
  promptStyle: "technical" | "pm";
  decompose: boolean;
  confirm: boolean;
  model?: string;
  issueType: string;
  projectKey?: string;
  interactiveHandle: Awaited<ReturnType<typeof runInteractiveMode>> | null;
  config: Awaited<ReturnType<typeof loadConfig>>;
  engine: PmEngine;
}

/**
 * Runs agent generation + task creation for one CLI or interactive create cycle.
 *
 * @returns `true` when interactive mode should loop for another task; `false` when done.
 */
async function runCreateFlow(params: CreateFlowParams): Promise<boolean> {
  const {
    source,
    epicKey,
    extraInstructions,
    promptStyle,
    decompose,
    confirm,
    model,
    issueType,
    projectKey,
    interactiveHandle,
    config,
    engine,
  } = params;

  try {
    // Step 1: Run Agent to create story from source
    const sourceTypeLabel =
      source.type === "figma"
        ? "Figma design"
        : source.type === "log"
          ? "error log"
          : "free-form prompt";
    if (!interactiveHandle) {
      console.log(`Step 1: Creating ${engine.backendName} story from ${sourceTypeLabel}\n`);
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

    // In interactive mode, show generating state
    const interactiveUi = interactiveHandle;
    if (interactiveUi) {
      interactiveUi.setGenerating();
    } else {
      console.log(`\n🤖 Running ${config.agent.harness.displayName}...\n`);
    }

    let storyData: StoryDraft;
    try {
      storyData = await engine.generateStory(
        { source, promptStyle, epicKey, extraInstructions },
        {
          onAgentChunk: interactiveUi
            ? (chunk, stream) => {
                if (stream !== "stderr") return;
                const line = lastStderrLine(chunk);
                if (line) {
                  interactiveUi.setStatusMessage(line);
                }
              }
            : undefined,
        },
      );
    } catch (error) {
      if (error instanceof EngineError && error.code === "agent-failed") {
        const dumpHint = error.dumpFile ? `\nFull agent output: ${error.dumpFile}` : "";
        if (interactiveHandle) {
          await showInteractiveMessageAndRestart(
            interactiveHandle,
            `Error: Failed to analyze ${sourceTypeLabel}\n${error.detail}${dumpHint}`,
          );
          return true; // continue create-another loop
        }
        console.error(`❌ Failed to analyze ${sourceTypeLabel}`);
        console.error(error.detail);
        if (error.dumpFile) {
          console.error(`Full agent output: ${error.dumpFile}`);
        }
        process.exit(1);
      }
      if (error instanceof EngineError && error.code === "parse-failed") {
        const dumpHint = error.dumpFile ? `\nFull agent output: ${error.dumpFile}` : "";
        if (interactiveHandle) {
          await showInteractiveMessageAndRestart(
            interactiveHandle,
            `Error: Failed to parse story from agent output\n${error.message}${dumpHint}`,
          );
          return true; // continue create-another loop
        }
        console.error("\n❌ Failed to parse story requirements from Agent output");
        console.error("Error:", error.message);
        console.error("Output:", error.detail);
        if (error.dumpFile) {
          console.error(`Full agent output (incl. stderr): ${error.dumpFile}`);
        }
        process.exit(1);
      }
      throw error;
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
        ui.setStatusMessage("Updating task description...");

        try {
          storyData = await engine.editStory(
            {
              current: {
                summary: editRequest.currentSummary,
                description: editRequest.currentDescription,
              },
              editPrompt: editRequest.editPrompt,
              issueType,
            },
            {
              onAgentChunk: (chunk, stream) => {
                if (stream !== "stderr") return;
                const line = lastStderrLine(chunk);
                if (line) {
                  ui.setStatusMessage(line);
                }
              },
            },
          );

          // Show updated preview
          ui.setPreviewData(storyData.summary, storyData.description);
        } catch (error) {
          if (error instanceof EngineError && error.code === "agent-failed") {
            ui.setStatusMessage(`Update failed: ${error.detail}`);
            continue;
          }
          console.error("❌ Failed to parse updated task from Agent");
          console.error("Error:", error instanceof Error ? error.message : error);
          if (error instanceof EngineError && error.dumpFile) {
            ui.setStatusMessage(`Update failed to parse — full agent output: ${error.dumpFile}`);
          }
          // Loop will retry
        }
      }
    }

    if (!interactiveHandle) {
      console.log(`\n📝 Creating ${engine.backendName} ${issueType.toLowerCase()}...`);
      console.log(`   Title: ${storyData.summary}`);
    }

    // Create the task via backend (links to epic when supported by the tracker;
    // trackers without epic support skip linking silently so we never create a
    // misleading attachment/text reference).
    const createResult = await engine.createTask(storyData, { issueType, projectKey, epicKey });
    const createdTask = createResult.task;

    if (!interactiveHandle) {
      console.log(
        `\n✅ ${engine.backendName} ${issueType.toLowerCase()} created: ${createdTask.url}`,
      );
    }

    if (createResult.epicLinked && !interactiveHandle) {
      console.log(`🔗 Linking story to epic ${epicKey}...`);
      console.log(`✅ Story linked to epic ${epicKey}`);
    }
    if (createResult.epicLinkError) {
      console.error(`⚠️  Warning: Failed to link to epic: ${createResult.epicLinkError}`);
      if (!interactiveHandle) {
        console.log("Continuing with task decomposition...");
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

      // In interactive mode, show success and wait for user to start another task
      if (interactiveHandle) {
        await showInteractiveMessageAndRestart(
          interactiveHandle,
          `Task created: ${createdTask.url}`,
        );
        return true; // continue create-another loop (same Ink session)
      }
      return false;
    }

    // Step 2: Run Agent to decompose the story into tasks
    console.log("Step 2: Decomposing story into tasks\n");
    console.log(`\n🤖 Running ${config.agent.harness.displayName}...\n`);

    let subtasks: Awaited<ReturnType<PmEngine["decomposeStory"]>>;
    try {
      subtasks = await engine.decomposeStory({
        story: storyData,
        sourceType: source.type,
        promptStyle,
      });
    } catch (error) {
      if (error instanceof EngineError && error.code === "agent-failed") {
        console.error("❌ Failed to decompose story");
        console.error(error.detail);
        if (error.dumpFile) {
          console.error(`Full agent output: ${error.dumpFile}`);
        }
        process.exit(1);
      }
      if (error instanceof EngineError && error.code === "parse-failed") {
        console.error("\n❌ Failed to parse subtasks from Agent output");
        console.error("Error:", error.message);
        console.error("Output:", error.detail);
        if (error.dumpFile) {
          console.error(`Full agent output (incl. stderr): ${error.dumpFile}`);
        }
        process.exit(1);
      }
      throw error;
    }

    console.log(`\n✅ Agent suggested ${subtasks.length} subtasks\n`);

    if (confirm) {
      console.log("📝 Review and confirm each subtask:\n");
    } else {
      console.log(`📝 Creating subtasks in ${engine.backendName}...\n`);
    }

    // Create each subtask via API
    const createdSubtasks = [];
    const skippedSubtasks = [];

    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i];
      if (!subtask) continue;

      // If confirmation mode is enabled, ask user
      if (confirm) {
        // Visual separator between tasks
        console.log("\n" + "─".repeat(80));
        console.log(`\n📋 Task ${i + 1}/${subtasks.length}`);
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
        const created = await engine.createSubtask(createdTask.key, subtask, projectKey);
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

    // In interactive mode, show success and wait for user to start another task
    if (interactiveHandle) {
      await showInteractiveMessageAndRestart(interactiveHandle, `Task created: ${createdTask.url}`);
      return true; // continue create-another loop (same Ink session)
    }
    return false;
  } catch (error) {
    if (isInteractiveCancelled(error)) {
      throw error;
    }
    console.error("\n❌ Error:", error instanceof Error ? error.message : error);
    // In interactive mode, show error and wait for user to restart in-place
    if (interactiveHandle) {
      await showInteractiveMessageAndRestart(
        interactiveHandle,
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return true; // continue create-another loop
    }
    process.exit(1);
  }
}

// Run CLI mode
main();
