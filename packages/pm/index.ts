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
import {
  captureError,
  flushErrorTracking,
  initErrorTracking,
  maybeOfferCliUpdate,
  resolveConfigDir,
} from "@devintern/utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Version is injected at build time via --define; falls back to package.json for `bun run`.
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

/**
 * Read SENTRY_DSN from `.devintern-pm/.env` (same resolution as loadConfig)
 * so error tracking works without exporting the DSN into the shell.
 */
function readDsnFromPmEnv(): string | undefined {
  try {
    const configDir = resolveConfigDir({ configDirName: ".devintern-pm" });
    const content = readFileSync(join(configDir, ".env"), "utf8");
    const match = /^SENTRY_DSN=(.*)$/m.exec(content);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    return value ? value : undefined;
  } catch {
    return undefined;
  }
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

  if (args.includes("--version") || args.includes("-V")) {
    console.log(VERSION);
    process.exit(0);
  }

  // Extract harness flag up front so the harness can be validated once for
  // both interactive and non-interactive modes.
  const harnessFlags = extractHarnessFlags(args);

  // Migrate legacy .claude-pm directory to .devintern-pm if needed
  await migrateLegacyConfigDir();

  // Sentry error tracking — no-op unless SENTRY_DSN is set (shell env or
  // .devintern-pm/.env). Initialized after migration so the config dir is final.
  initErrorTracking({
    dsn: process.env.SENTRY_DSN ?? readDsnFromPmEnv(),
    release: `pm@${VERSION}`,
    environment: process.env.NODE_ENV ?? "production",
  });

  // Parse arguments - null means interactive mode, 'init' means run initialization.
  // Help exits inside parseArgs before any update check.
  const parsedArgs = parseArgs(args);

  // Check npm for a newer global `@getdevintern/pm` before real work.
  // Non-interactive sessions skip install by default.
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

  // Validate the harness name (if any) only for modes that actually use it.
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
  let interactiveHandle: Awaited<ReturnType<typeof runInteractiveMode>> | null = null;
  let configForInteractive: Awaited<ReturnType<typeof loadConfig>> | undefined;

  try {
    // Load config early for all operational modes. Interactive use is free
    // under FSL, so pm performs no license check.
    configForInteractive = await loadConfig({
      harnessName: harnessFlags.harness,
    });

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
        // loadConfig() already validated the active harness; keep it in the
        // picker even if detection via PATH alone would miss a custom path.
        const harnessesForPicker = installedHarnesses.some((h) => h.name === currentHarness.name)
          ? installedHarnesses
          : [currentHarness, ...installedHarnesses];
        const harnesses = harnessesForPicker.map((h) => ({
          name: h.name,
          displayName: h.displayName,
        }));
        interactiveHandle = await runInteractiveMode({
          projects: projectsData,
          defaultProjectKey: engine.defaultProjectKey,
          issueTypes: issueTypeNames,
          fetchIssueTypes: engine.supportsIssueTypes
            ? (projectKey: string) => engine.listIssueTypes(projectKey)
            : undefined,
          backendName: engine.backendName,
          harnesses,
          currentHarnessName: configForInteractive.agent.harness.name,
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

        // Re-resolve harness if user selected a different one in interactive mode.
        // Engine reads config.agent at call time, so mutating config is enough.
        if (
          interactiveConfig.harnessName &&
          interactiveConfig.harnessName !== config.agent.harness.name
        ) {
          validateHarnessName(interactiveConfig.harnessName);
          const resolved = resolveHarness({
            harnessName: interactiveConfig.harnessName,
          });
          resolved.path = resolveExecutablePathStrict(resolved.path, resolved.harness.displayName);
          config.agent = resolved;
        }

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
    const attachments = cliArgs.attachments;

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
      attachments,
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
    captureError(error);
    console.error("\n❌ Error:", error instanceof Error ? error.message : error);
    await flushErrorTracking();
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
    attachments,
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
      if (attachments?.length) {
        console.log(`Attachments: ${attachments.map((a) => a.path).join(", ")}`);
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
        { source, promptStyle, epicKey, extraInstructions, attachments },
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
    const createResult = await engine.createTask(storyData, {
      issueType,
      projectKey,
      epicKey,
      attachments,
    });
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
    if (createResult.labelsApplyError) {
      console.error(`⚠️  Warning: Failed to apply labels: ${createResult.labelsApplyError}`);
    }
    if (createResult.attachmentsUploaded > 0 && !interactiveHandle) {
      console.log(`📎 Uploaded ${createResult.attachmentsUploaded} attachment(s)`);
    }
    if (createResult.attachmentErrors?.length) {
      for (const err of createResult.attachmentErrors) {
        console.error(`⚠️  Warning: Failed to upload attachment: ${err}`);
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

// Global error handlers — report to Sentry (when configured), then exit.
process.on("unhandledRejection", (reason: unknown) => {
  console.error("\n❌ Unhandled error:", reason instanceof Error ? reason.message : reason);
  captureError(reason);
  void flushErrorTracking().finally(() => process.exit(1));
});

process.on("uncaughtException", (error: Error) => {
  console.error("\n❌ Uncaught exception:", error.message);
  captureError(error);
  void flushErrorTracking().finally(() => process.exit(1));
});

// Run CLI mode
main();
