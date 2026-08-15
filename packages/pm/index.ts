#!/usr/bin/env node

/**
 * CLI utility to create tasks from Figma designs, logs, or prompts
 * and store them in Jira, Linear, Markdown files, or other backends.
 */

import { askConfirm } from "./lib/runtime/stdin.js";
import { getArgs } from "./lib/runtime/args.js";
import { configureTerminalEncoding } from "./lib/runtime/terminal.js";
import { getModuleDir } from "./lib/runtime/path.js";
import { loadConfig, loadSupabaseConfig, migrateLegacyConfigDir } from "./lib/config";
import { createEngine, DEFAULT_ISSUE_TYPES, EngineError } from "./lib/engine";
import type { PmEngine, SourceInput, StoryDraft } from "./lib/engine";
import { runInteractiveMode } from "./lib/components/interactive";
import type {
  InteractiveModeHandle,
  InteractiveState,
  InteractiveTicketAction,
} from "./lib/components/interactive";
import { getTicket } from "./lib/ticket-workspaces";
import { initializeProject } from "./lib/init";
import { isInteractive, runPmInitWizard } from "./lib/init-wizard";
import { extractHarnessFlags, parseArgs, validateHarnessName } from "./lib/parse-args";
import type { CLIArgs } from "./lib/parse-args";
import { runConnect } from "./lib/chat/connect";
import { runServe } from "./lib/chat/serve";
import {
  listInstalledHarnesses,
  resolveExecutablePathStrict,
  resolveHarness,
} from "@devintern/agent-harness";
import { getAuthenticatedUser, login, logout, resolveLogin } from "@devintern/auth";
import { maybeOfferCliUpdate } from "@devintern/utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";

declare const __VERSION__: string;

function readPackageVersion(): string {
  try {
    const pkgPath = join(getModuleDir(import.meta.url), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : readPackageVersion();

/** Extract the last non-empty line from an agent stderr chunk for status display. */
function lastStderrLine(chunk: string): string | undefined {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1);
}

/**
 * Show a success/error screen on a specific ticket. The user restarts that ticket
 * via any-key (or opens another from the sidebar) — restart is handled by the
 * multi-ticket action loop, not here.
 *
 * @param handle - Active interactive mode handle.
 * @param ticketId - Workspace to update.
 * @param message - Error or status text shown on the success screen.
 * @param createdKey - Optional tracker key for sidebar identity.
 */
function showTicketMessage(
  handle: InteractiveModeHandle,
  ticketId: string,
  message: string,
  createdKey?: string,
): void {
  // Only update if the ticket is still open (user may have closed it mid-run).
  if (!getTicket(handle.getWorkspaces(), ticketId)) return;
  handle.showSuccess(message, { ticketId, createdKey });
}

/** True when an interactive waiter rejected because the user cancelled (Ctrl+C / unmount). */
function isInteractiveCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === "Interactive mode cancelled";
}

/**
 * Per-ticket draft cache so background agent runs can complete create/edit
 * after the user switches away.
 */
type TicketDraftMap = Map<string, StoryDraft>;
type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

async function createTicketEngine(
  config: LoadedConfig,
  harnessName: string | undefined,
): Promise<PmEngine> {
  if (!harnessName || harnessName === config.agent.harness.name) {
    return createEngine({ ...config, agent: config.agent });
  }
  validateHarnessName(harnessName);
  const resolved = resolveHarness({ harnessName });
  resolved.path = resolveExecutablePathStrict(resolved.path, resolved.harness.displayName);
  return createEngine({ ...config, agent: resolved });
}

/**
 * Run story generation for one ticket without blocking other tickets.
 */
async function runTicketGenerate(params: {
  ticketId: string;
  config: InteractiveState;
  handle: InteractiveModeHandle;
  appConfig: LoadedConfig;
  drafts: TicketDraftMap;
}): Promise<void> {
  const { ticketId, config, handle, appConfig, drafts } = params;
  if (!config.sourceType || !config.sourceContent) {
    showTicketMessage(handle, ticketId, "Error: Incomplete ticket configuration");
    return;
  }

  const source: SourceInput = {
    type: config.sourceType,
    content: config.sourceContent,
  };
  const sourceTypeLabel =
    source.type === "figma"
      ? "Figma design"
      : source.type === "log"
        ? "error log"
        : "free-form prompt";

  handle.setGenerating(ticketId);

  try {
    const ticketEngine = await createTicketEngine(appConfig, config.harnessName);
    const storyData = await ticketEngine.generateStory(
      {
        source,
        promptStyle: config.promptStyle,
        epicKey: config.epicKey,
        extraInstructions: config.customInstructions,
      },
      {
        onAgentChunk: (chunk, stream) => {
          if (stream !== "stderr") return;
          if (!getTicket(handle.getWorkspaces(), ticketId)) return;
          const line = lastStderrLine(chunk);
          if (line) handle.setStatusMessage(line, ticketId);
        },
      },
    );

    if (!getTicket(handle.getWorkspaces(), ticketId)) return;
    drafts.set(ticketId, storyData);
    handle.setPreviewData(storyData.summary, storyData.description, ticketId);
  } catch (error) {
    if (!getTicket(handle.getWorkspaces(), ticketId)) return;
    if (error instanceof EngineError && error.code === "agent-failed") {
      const dumpHint = error.dumpFile ? `\nFull agent output: ${error.dumpFile}` : "";
      showTicketMessage(
        handle,
        ticketId,
        `Error: Failed to analyze ${sourceTypeLabel}\n${error.detail}${dumpHint}`,
      );
      return;
    }
    if (error instanceof EngineError && error.code === "parse-failed") {
      const dumpHint = error.dumpFile ? `\nFull agent output: ${error.dumpFile}` : "";
      showTicketMessage(
        handle,
        ticketId,
        `Error: Failed to parse story from agent output\n${error.message}${dumpHint}`,
      );
      return;
    }
    showTicketMessage(
      handle,
      ticketId,
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Run story edit for one ticket without blocking other tickets.
 */
async function runTicketEdit(params: {
  ticketId: string;
  editPrompt: string;
  currentSummary: string;
  currentDescription: string;
  issueType: string;
  handle: InteractiveModeHandle;
  appConfig: LoadedConfig;
  harnessName?: string;
  drafts: TicketDraftMap;
}): Promise<void> {
  const {
    ticketId,
    editPrompt,
    currentSummary,
    currentDescription,
    issueType,
    handle,
    appConfig,
    harnessName,
    drafts,
  } = params;

  handle.setStatusMessage("Updating task description...", ticketId);

  try {
    const ticketEngine = await createTicketEngine(appConfig, harnessName);
    const storyData = await ticketEngine.editStory(
      {
        current: { summary: currentSummary, description: currentDescription },
        editPrompt,
        issueType,
      },
      {
        onAgentChunk: (chunk, stream) => {
          if (stream !== "stderr") return;
          if (!getTicket(handle.getWorkspaces(), ticketId)) return;
          const line = lastStderrLine(chunk);
          if (line) handle.setStatusMessage(line, ticketId);
        },
      },
    );

    if (!getTicket(handle.getWorkspaces(), ticketId)) return;
    drafts.set(ticketId, storyData);
    handle.setPreviewData(storyData.summary, storyData.description, ticketId);
  } catch (error) {
    if (!getTicket(handle.getWorkspaces(), ticketId)) return;
    if (error instanceof EngineError && error.code === "agent-failed") {
      handle.setStatusMessage(`Update failed: ${error.detail}`, ticketId);
      // Return to preview so the user can retry edit or create
      handle.setPreviewData(currentSummary, currentDescription, ticketId);
      return;
    }
    const dump =
      error instanceof EngineError && error.dumpFile
        ? ` — full agent output: ${error.dumpFile}`
        : "";
    handle.setStatusMessage(`Update failed to parse${dump}`, ticketId);
    handle.setPreviewData(currentSummary, currentDescription, ticketId);
  }
}

/**
 * Create the tracker task for one ticket from its cached draft.
 */
async function runTicketCreate(params: {
  ticketId: string;
  config: InteractiveState;
  handle: InteractiveModeHandle;
  engine: PmEngine;
  drafts: TicketDraftMap;
}): Promise<void> {
  const { ticketId, config, handle, engine, drafts } = params;
  const storyData = drafts.get(ticketId) ?? config.previewData;
  if (!storyData) {
    showTicketMessage(handle, ticketId, "Error: No draft available to create");
    return;
  }

  const draft: StoryDraft = {
    summary: storyData.summary,
    description: storyData.description,
  };

  try {
    const createResult = await engine.createTask(draft, {
      issueType: config.issueType,
      projectKey: config.projectKey,
      epicKey: config.epicKey,
    });
    if (!getTicket(handle.getWorkspaces(), ticketId)) return;

    let message = `Task created: ${createResult.task.url}`;
    if (createResult.epicLinkError) {
      message += `\nWarning: Failed to link to epic: ${createResult.epicLinkError}`;
    }
    showTicketMessage(handle, ticketId, message, createResult.task.key);
    drafts.delete(ticketId);
  } catch (error) {
    if (!getTicket(handle.getWorkspaces(), ticketId)) return;
    showTicketMessage(
      handle,
      ticketId,
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Multi-ticket interactive session: listen for per-ticket actions and run
 * agent/tracker work concurrently so switching never cancels background runs.
 */
async function runInteractiveSession(params: {
  handle: InteractiveModeHandle;
  engine: PmEngine;
  config: LoadedConfig;
}): Promise<void> {
  const { handle, engine, config } = params;
  const drafts: TicketDraftMap = new Map();

  while (true) {
    let action: InteractiveTicketAction;
    try {
      action = await handle.waitForAction();
    } catch (error) {
      if (isInteractiveCancelled(error)) {
        handle.cleanup();
        console.log("\nBye!");
        process.exit(0);
      }
      throw error;
    }

    switch (action.type) {
      case "generate":
        // Fire-and-forget so other tickets can still generate/edit/create.
        void runTicketGenerate({
          ticketId: action.ticketId,
          config: action.config,
          handle,
          appConfig: config,
          drafts,
        });
        break;
      case "edit": {
        const ticket = getTicket(handle.getWorkspaces(), action.ticketId);
        const issueType = ticket?.wizard.issueType ?? "Task";
        void runTicketEdit({
          ticketId: action.ticketId,
          editPrompt: action.editPrompt,
          currentSummary: action.currentSummary,
          currentDescription: action.currentDescription,
          issueType,
          handle,
          appConfig: config,
          harnessName: ticket?.wizard.harnessName,
          drafts,
        });
        break;
      }
      case "create":
        void runTicketCreate({
          ticketId: action.ticketId,
          config: action.config,
          handle,
          engine,
          drafts,
        });
        break;
      case "restart":
        handle.restart(action.ticketId);
        drafts.delete(action.ticketId);
        break;
    }
  }
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

  if (args.includes("--version") || args.includes("-V")) {
    console.log(VERSION);
    process.exit(0);
  }

  const harnessFlags = extractHarnessFlags(args);

  // Migrate legacy .claude-pm directory to .devintern-pm if needed
  await migrateLegacyConfigDir();

  // Parse arguments - null means interactive mode, 'init' means run initialization
  const parsedArgs = parseArgs(args);

  await maybeOfferCliUpdate({
    packageName: "@getdevintern/pm",
    binName: "devpm",
    currentVersion: VERSION,
    isInteractive: isInteractive(process.argv, process.stdin),
    confirm: askConfirm,
    noUpdateEnv: "DEVPM_NO_UPDATE",
    autoUpdateEnv: "DEVPM_AUTO_UPDATE",
  });

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

  if (parsedArgs === "serve") {
    const platformFlag = args[args.indexOf("--platform") + 1];
    const modelFlag = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
    await runServe({
      platforms:
        args.includes("--platform") && (platformFlag === "slack" || platformFlag === "telegram")
          ? [platformFlag]
          : undefined,
      model: modelFlag,
    });
    return;
  }

  if (typeof parsedArgs === "object" && parsedArgs !== null && "connect" in parsedArgs) {
    await runConnect(parsedArgs.connect);
    return;
  }

  if (parsedArgs === "login") {
    try {
      const supabaseConfig = await loadSupabaseConfig();
      const resolved = await resolveLogin(process.argv);
      const user = await login(supabaseConfig, resolved);
      console.log(`✅ Signed in as ${user.email || user.id}`);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
      process.exit(1);
    }
    return;
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
    console.log(
      user ? `Signed in as ${user.email || user.id}` : "Not signed in. Run `devpm login`.",
    );
    return;
  }

  validateHarnessName(harnessFlags.harness);
  let source: SourceInput;
  let epicKey: string | undefined;
  let extraInstructions: string | undefined;
  let promptStyle: "technical" | "pm";
  let decompose: boolean;
  let confirm: boolean;
  let model: string | undefined;
  let issueType: string;
  let projectKey: string | undefined;
  let interactiveHandle: InteractiveModeHandle | null = null;
  let configForInteractive: Awaited<ReturnType<typeof loadConfig>> | undefined;

  try {
    // Load config early for all operational modes. Interactive use is free
    // under FSL, so pm performs no license check.
    configForInteractive = await loadConfig({ harnessName: harnessFlags.harness });

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
          issueTypeNames = [...DEFAULT_ISSUE_TYPES];
        }
      }

      try {
        const currentHarness = configForInteractive.agent.harness;
        const installedHarnesses = listInstalledHarnesses({
          currentHarnessName: currentHarness.name,
        });
        const harnessesForPicker = installedHarnesses.some((h) => h.name === currentHarness.name)
          ? installedHarnesses
          : [currentHarness, ...installedHarnesses];
        interactiveHandle = await runInteractiveMode({
          projects: projectsData,
          defaultProjectKey: engine.defaultProjectKey,
          issueTypes: issueTypeNames,
          fetchIssueTypes: engine.supportsIssueTypes
            ? (projectKey: string) => engine.listIssueTypes(projectKey)
            : undefined,
          backendName: engine.backendName,
          harnesses: harnessesForPicker.map((h) => ({
            name: h.name,
            displayName: h.displayName,
          })),
          currentHarnessName: currentHarness.name,
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

      // Multi-ticket session: concurrent per-ticket agent runs, sidebar switch/close.
      await runInteractiveSession({
        handle: interactiveHandle,
        engine,
        config: configForInteractive,
      });
      return;
    }

    // CLI mode (one-shot)
    const cliArgs: CLIArgs = parsedArgs;
    source = cliArgs.source;
    epicKey = cliArgs.epicKey;
    extraInstructions = cliArgs.extraInstructions;
    promptStyle = cliArgs.promptStyle;
    decompose = cliArgs.decompose;
    confirm = cliArgs.confirm;
    model = cliArgs.model;
    issueType = cliArgs.issueType;
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
      attachments: cliArgs.attachments,
      config,
      engine,
    });
  } catch (error) {
    if (isInteractiveCancelled(error)) {
      const handle = interactiveHandle as InteractiveModeHandle | null;
      handle?.cleanup();
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
  attachments?: Array<{ path: string; name?: string }>;
  config: Awaited<ReturnType<typeof loadConfig>>;
  engine: PmEngine;
}

/**
 * Runs agent generation + task creation for one non-interactive CLI create cycle.
 */
async function runCreateFlow(params: CreateFlowParams): Promise<void> {
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
    attachments,
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
    if (attachments?.length) {
      console.log(`Attachments: ${attachments.map((attachment) => attachment.path).join(", ")}`);
    }

    console.log(`\n🤖 Running ${config.agent.harness.displayName}...\n`);

    let storyData: StoryDraft;
    try {
      storyData = await engine.generateStory({
        source,
        promptStyle,
        epicKey,
        extraInstructions,
        attachments,
      });
    } catch (error) {
      if (error instanceof EngineError && error.code === "agent-failed") {
        console.error(`❌ Failed to analyze ${sourceTypeLabel}`);
        console.error(error.detail);
        if (error.dumpFile) {
          console.error(`Full agent output: ${error.dumpFile}`);
        }
        process.exit(1);
      }
      if (error instanceof EngineError && error.code === "parse-failed") {
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

    console.log(`\n📝 Creating ${engine.backendName} ${issueType.toLowerCase()}...`);
    console.log(`   Title: ${storyData.summary}`);

    // Create the task via backend (links to epic when supported by the tracker;
    // trackers without epic support skip linking silently so we never create a
    // misleading attachment/text reference).
    const createResult = await engine.createTask(storyData, {
      issueType,
      projectKey,
      epicKey,
      attachments,
    });
    const createdTask = createResult.task;

    console.log(
      `\n✅ ${engine.backendName} ${issueType.toLowerCase()} created: ${createdTask.url}`,
    );

    if (createResult.epicLinked) {
      console.log(`🔗 Linking story to epic ${epicKey}...`);
      console.log(`✅ Story linked to epic ${epicKey}`);
    }
    if (createResult.epicLinkError) {
      console.error(`⚠️  Warning: Failed to link to epic: ${createResult.epicLinkError}`);
      console.log("Continuing with task decomposition...");
    }
    if (createResult.labelsApplyError) {
      console.error(`⚠️  Warning: Failed to apply labels: ${createResult.labelsApplyError}`);
    }
    if (createResult.attachmentsUploaded > 0) {
      console.log(`📎 Uploaded ${createResult.attachmentsUploaded} attachment(s)`);
    }
    if (createResult.attachmentErrors?.length) {
      for (const error of createResult.attachmentErrors) {
        console.error(`⚠️  Warning: Failed to upload attachment: ${error}`);
      }
    }
    console.log();

    // Check if we should decompose into subtasks
    if (!decompose) {
      console.log(`✅ ${issueType} created successfully!\n`);
      console.log("Summary:");
      console.log(`  ${issueType}: ${createdTask.url}`);
      if (epicKey) {
        console.log(`  Epic: ${epicKey}`);
      }
      console.log("\n🎉 Done!");
      return;
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
  } catch (error) {
    if (isInteractiveCancelled(error)) {
      throw error;
    }
    console.error("\n❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run CLI mode
main();
