/** Task creation flow shared by batch and interactive CLI modes. */

import { askConfirm } from "./runtime/stdin.js";
import { formatCliError } from "./runtime/proxy.js";
import { loadConfig } from "./config";
import { EngineError } from "./engine";
import type { PmEngine, SourceInput, StoryDraft } from "./engine";
import { runInteractiveMode } from "./components/interactive";

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
export function isInteractiveCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === "Interactive mode cancelled";
}

export type InteractiveHandle = Awaited<ReturnType<typeof runInteractiveMode>>;
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

/** Human-readable label for the source type. */
function describeSourceType(type: SourceInput["type"]): string {
  if (type === "figma") return "Figma design";
  if (type === "log") return "error log";
  return "free-form prompt";
}

/** Print the CLI-mode plan banner for the source about to be analyzed. */
function printCreateFlowPlan(params: {
  engine: PmEngine;
  source: SourceInput;
  promptStyle: "technical" | "pm";
  issueType: string;
  sourceTypeLabel: string;
  model?: string;
  epicKey?: string;
  extraInstructions?: string;
  attachments?: Array<{ path: string; name?: string }>;
}): void {
  const {
    engine,
    source,
    promptStyle,
    issueType,
    sourceTypeLabel,
    model,
    epicKey,
    extraInstructions,
    attachments,
  } = params;
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

/**
 * Generate the story draft, handling the two engine error shapes.
 *
 * @returns The draft, or `"continue"` when interactive mode should restart.
 */
async function generateStoryDraft(
  engine: PmEngine,
  interactiveUi: InteractiveHandle | null,
  input: {
    source: SourceInput;
    promptStyle: "technical" | "pm";
    epicKey?: string;
    extraInstructions?: string;
    attachments?: Array<{ path: string; name?: string }>;
  },
  sourceTypeLabel: string,
): Promise<StoryDraft | "continue"> {
  try {
    return await engine.generateStory(input, {
      onAgentChunk: interactiveUi
        ? (chunk, stream) => {
            if (stream !== "stderr") return;
            const line = lastStderrLine(chunk);
            if (line) {
              interactiveUi.setStatusMessage(line);
            }
          }
        : undefined,
    });
  } catch (error) {
    if (error instanceof EngineError && error.code === "agent-failed") {
      const dumpHint = error.dumpFile ? `\nFull agent output: ${error.dumpFile}` : "";
      if (interactiveUi) {
        await showInteractiveMessageAndRestart(
          interactiveUi,
          `Error: Failed to analyze ${sourceTypeLabel}\n${error.detail}${dumpHint}`,
        );
        return "continue"; // continue create-another loop
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
      if (interactiveUi) {
        await showInteractiveMessageAndRestart(
          interactiveUi,
          `Error: Failed to parse story from agent output\n${error.message}${dumpHint}`,
        );
        return "continue"; // continue create-another loop
      }
      console.error("\n❌ Failed to parse story requirements from Agent output");
      console.error(error.message);
      console.error("Output:", error.detail);
      if (error.dumpFile) {
        console.error(`Full agent output (incl. stderr): ${error.dumpFile}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

/** Show the story preview and let the user edit it until they confirm. */
async function runPreviewEditLoop(
  ui: InteractiveHandle,
  engine: PmEngine,
  initialStory: StoryDraft,
  issueType: string,
): Promise<StoryDraft> {
  let storyData = initialStory;
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
  return storyData;
}

/** Print the post-create status, warnings, and attachment summary. */
function reportCreateTaskResult(params: {
  engine: PmEngine;
  createResult: Awaited<ReturnType<PmEngine["createTask"]>>;
  createdTask: Awaited<ReturnType<PmEngine["createTask"]>>["task"];
  interactiveHandle: InteractiveHandle | null;
  issueType: string;
  epicKey?: string;
}): void {
  const { engine, createResult, createdTask, interactiveHandle, issueType, epicKey } = params;
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
}

/** Decompose the story, handling the two engine error shapes. */
async function decomposeStoryWithHandling(
  engine: PmEngine,
  storyData: StoryDraft,
  sourceType: SourceInput["type"],
  promptStyle: "technical" | "pm",
): Promise<Awaited<ReturnType<PmEngine["decomposeStory"]>>> {
  try {
    return await engine.decomposeStory({
      story: storyData,
      sourceType,
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
      console.error(error.message);
      console.error("Output:", error.detail);
      if (error.dumpFile) {
        console.error(`Full agent output (incl. stderr): ${error.dumpFile}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

type SubtaskDraft = Awaited<ReturnType<PmEngine["decomposeStory"]>>[number];
type CreatedSubtask = Awaited<ReturnType<PmEngine["createSubtask"]>>;

interface SubtaskCreationResult {
  created: CreatedSubtask[];
  skipped: string[];
}

/** Create each decomposed subtask, optionally confirming each first. */
async function createSubtasks(
  engine: PmEngine,
  createdTask: Awaited<ReturnType<PmEngine["createTask"]>>["task"],
  subtasks: SubtaskDraft[],
  projectKey: string | undefined,
  confirm: boolean,
): Promise<SubtaskCreationResult> {
  const created: CreatedSubtask[] = [];
  const skipped: string[] = [];

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
        skipped.push(subtask.summary);
        console.log(`⏭️  Skipped\n`);
        continue;
      }
    }

    try {
      const createdSubtask = await engine.createSubtask(createdTask.key, subtask, projectKey);
      created.push(createdSubtask);
      if (confirm) {
        console.log(`✅ Created: ${createdSubtask.key}\n`);
      } else {
        console.log(`   ✅ ${createdSubtask.key}: ${subtask.summary}`);
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

  return { created, skipped };
}

/** Print the decomposition summary. */
function printDecomposeSummary(params: {
  issueType: string;
  createdTask: Awaited<ReturnType<PmEngine["createTask"]>>["task"];
  createdSubtasks: CreatedSubtask[];
  skippedSubtasks: string[];
  epicKey?: string;
}): void {
  const { issueType, createdTask, createdSubtasks, skippedSubtasks, epicKey } = params;
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
}

/**
 * Runs agent generation + task creation for one CLI or interactive create cycle.
 *
 * @returns `true` when interactive mode should loop for another task; `false` when done.
 */
export async function runCreateFlow(params: CreateFlowParams): Promise<boolean> {
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
    const sourceTypeLabel = describeSourceType(source.type);
    if (!interactiveHandle) {
      printCreateFlowPlan({
        engine,
        source,
        promptStyle,
        issueType,
        sourceTypeLabel,
        model,
        epicKey,
        extraInstructions,
        attachments,
      });
    }

    // In interactive mode, show generating state
    const interactiveUi = interactiveHandle;
    if (interactiveUi) {
      interactiveUi.setGenerating();
    } else {
      console.log(`\n🤖 Running ${config.agent.harness.displayName}...\n`);
    }

    const storyResult = await generateStoryDraft(
      engine,
      interactiveUi,
      { source, promptStyle, epicKey, extraInstructions, attachments },
      sourceTypeLabel,
    );
    if (storyResult === "continue") {
      return true; // continue create-another loop
    }
    let storyData = storyResult;

    // In interactive mode, show preview and wait for confirmation or edits
    if (interactiveHandle) {
      storyData = await runPreviewEditLoop(interactiveHandle, engine, storyData, issueType);
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
    reportCreateTaskResult({
      engine,
      createResult,
      createdTask,
      interactiveHandle,
      issueType,
      epicKey,
    });

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

    const subtasks = await decomposeStoryWithHandling(engine, storyData, source.type, promptStyle);

    console.log(`\n✅ Agent suggested ${subtasks.length} subtasks\n`);

    if (confirm) {
      console.log("📝 Review and confirm each subtask:\n");
    } else {
      console.log(`📝 Creating subtasks in ${engine.backendName}...\n`);
    }

    // Create each subtask via API
    const { created: createdSubtasks, skipped: skippedSubtasks } = await createSubtasks(
      engine,
      createdTask,
      subtasks,
      projectKey,
      confirm,
    );

    printDecomposeSummary({ issueType, createdTask, createdSubtasks, skippedSubtasks, epicKey });

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
    console.error("\n❌ Error:", formatCliError(error));
    // In interactive mode, show error and wait for user to restart in-place
    if (interactiveHandle) {
      await showInteractiveMessageAndRestart(
        interactiveHandle,
        `Error: ${error instanceof Error ? formatCliError(error) : "Unknown error"}`,
      );
      return true; // continue create-another loop
    }
    process.exit(1);
  }
}
