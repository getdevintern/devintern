import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { UsageLimitError } from "@devintern/agent-harness";
import { isMarkdownFilePath } from "@devintern/task-trackers";
import { captureError, flushErrorTracking } from "@devintern/utils";
import { runAnalysisWithFallback } from "../agent/analysis-mode";
import { runEstimation } from "../automation/estimation";
import { loadProjectSettings } from "../config/project-settings";
import { flushAnalytics, trackInteractiveTaskRun } from "../observability/analytics";
import { beginRun } from "../state/run-recorder";
import { finishTaskRun } from "../state/task-run";
import { TaskFormatter } from "../task/formatter";
import { normalizeTaskKeys } from "../task/normalize-task-keys";
import { TaskTrackerManager } from "../trackers/manager";
import {
  isWorkerChild,
  USAGE_LIMIT_EXIT_CODE,
  writeUsageLimitHint,
} from "../worker/usage-limit-protocol";
import { flushAnalyticsAndExit } from "./bootstrap";
import { isWorkerTaskProcess, runContext } from "./context";

/**
 * Resolve which task keys to process from `--query` or positional arguments.
 *
 * @returns Task keys, or `null` when a query matched nothing (caller should stop)
 */
export async function resolveRunTargets(
  taskKeys: string[],
  activeTrackerType: string,
): Promise<string[] | null> {
  const options = runContext.options;
  if (options.query) {
    console.log(`🔍 Searching task tracker with query: ${options.query}`);

    const tracker = new TaskTrackerManager().getClient();
    const searchResult = await tracker.searchTasks(options.query);

    if (searchResult.tasks.length === 0) {
      console.log("⚠️  No tasks found matching the query");
      return null;
    }

    const tasksToProcess = searchResult.tasks.map((task) => task.key);
    console.log(`📋 Found ${tasksToProcess.length} tasks to process: ${tasksToProcess.join(", ")}`);
    return tasksToProcess;
  }

  if (taskKeys.length > 0) {
    // Individual task keys / file paths mode. File-path arguments are kept as-is;
    // PM task keys are normalised (e.g. Trello ref parsing).
    const pmArgs = taskKeys.filter((k) => !isMarkdownFilePath(k));
    const fileArgs = taskKeys.filter(isMarkdownFilePath);
    const tasksToProcess = [...normalizeTaskKeys(pmArgs, activeTrackerType), ...fileArgs];
    console.log(`📋 Processing ${tasksToProcess.length} task(s): ${tasksToProcess.join(", ")}`);
    return tasksToProcess;
  }

  // No tasks specified
  console.error(
    "❌ Error: No tasks specified. Provide task keys as arguments or use --query option.",
  );
  console.error("   Examples:");
  console.error("     devintern PROJ-123");
  console.error("     devintern PROJ-123 PROJ-124 PROJ-125");
  console.error("     devintern --query \"project = PROJ AND status = 'To Do'\"");
  console.error("     devintern ./tasks/feature-spec.md --no-git");
  console.error("     devintern ./epic.md ./subtask-a.md --no-git");
  return await flushAnalyticsAndExit(1);
}

/** Inputs for {@link runEstimationBatch}. */
export interface EstimationBatchInput {
  activeTrackerType: string;
  tasksToProcess: string[];
}

/**
 * `devintern --estimate`: estimate story points for each resolved task, then
 * release the lock and exit non-zero when any estimation failed.
 */
export async function runEstimationBatch(input: EstimationBatchInput): Promise<void> {
  const { activeTrackerType, tasksToProcess } = input;
  const options = runContext.options;
  const resolvedAgent = runContext.resolvedAgent;

  console.log("\n📊 Running in estimation mode...");

  const tracker = new TaskTrackerManager().getClient();
  const projectSettings = loadProjectSettings();
  const estimationResults = {
    total: 0,
    estimated: 0,
    skipped: 0,
    failed: 0,
    errors: [] as Array<{ taskKey: string; error: string }>,
  };

  for (const taskKey of tasksToProcess) {
    try {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`📊 Estimating: ${taskKey}`);

      // Fetch task to check creation date
      const task = await tracker.getTask(taskKey);

      // Skip tasks created less than 24 hours ago
      const createdDate = new Date(task.created);
      const now = new Date();
      const hoursAgo = (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60);

      if (hoursAgo < 24) {
        console.log(`⏭️  Skipping ${taskKey} — created ${hoursAgo.toFixed(1)}h ago (< 24h)`);
        estimationResults.skipped++;
        continue;
      }

      // Check if task already has an estimation comment
      const existingEstimation = await tracker.findEstimationComment(taskKey);
      let existingCommentId: string | undefined;

      if (existingEstimation) {
        // Compare estimation comment date with task updated date
        const estimationDate = new Date(existingEstimation.created);
        const taskUpdated = new Date(task.updated);

        if (taskUpdated <= estimationDate) {
          console.log(`⏭️  Skipping ${taskKey} — already estimated and not updated since`);
          estimationResults.skipped++;
          continue;
        }

        console.log(`🔄 Re-estimating ${taskKey} — task updated since last estimate`);
        existingCommentId = existingEstimation.commentId;
      }

      estimationResults.total++;

      // Structured run record for this attempt (skips above are not attempts).
      // Estimation is its own dashboard origin — never an implement run — and
      // scheduled sweeps carry the schedule id.
      const estimationScheduleId = process.env.DEVINTERN_AUTOMATION_ID;
      beginRun({
        origin: "estimate",
        taskKey,
        tracker: activeTrackerType,
        // Every origin records the harness that executed it.
        harness: resolvedAgent.harness.name,
        ...(estimationScheduleId ? { automationId: estimationScheduleId } : {}),
      });

      // Fetch comments and linked resources
      const comments = await tracker.getComments(taskKey);
      const linkedResources = tracker.extractLinkedResources(task);
      const relatedIssues = await tracker.getRelatedWorkItems(task);

      // Format task details
      const taskDetails = tracker.formatTaskDetails(task, comments, linkedResources, relatedIssues);

      // Create estimation prompt file
      const estimationFile = join(tmpdir(), `estimation-${taskKey.toLowerCase()}-${Date.now()}.md`);
      TaskFormatter.saveEstimationPrompt(taskDetails, estimationFile, process.env.JIRA_BASE_URL!);

      // Run estimation
      const result = await runAnalysisWithFallback(resolvedAgent.harness, 10, (runOptions) =>
        runEstimation({
          estimationFile,
          harness: resolvedAgent.harness,
          executablePath: resolvedAgent.path,
          taskKey,
          tracker,
          settings: projectSettings,
          skipComments: options.skipComments,
          existingCommentId,
          runOptions,
        }),
      );

      // Clean up temp file
      try {
        unlinkSync(estimationFile);
      } catch {
        // Ignore cleanup errors
      }

      if (result) {
        estimationResults.estimated++;
      } else {
        estimationResults.failed++;
        estimationResults.errors.push({
          taskKey,
          error: "Failed to parse estimation response",
        });
      }
      await finishTaskRun(
        result ? "succeeded" : "failed",
        result ? undefined : "Failed to parse estimation response",
      );
    } catch (error) {
      // Usage limit is account-global — abort the rest of the estimation batch
      // and exit 0 so the scheduler retries next window.
      if (error instanceof UsageLimitError) {
        await finishTaskRun("deferred", error.message);
        if (isWorkerChild()) {
          console.warn(`\n⏳ ${error.message}. Signaling worker to fail over.`);
          runContext.lockManager?.release();
          writeUsageLimitHint(error);
          await flushAnalyticsAndExit(USAGE_LIMIT_EXIT_CODE);
        }
        console.warn(`\n⏳ ${error.message}. Aborting estimation batch; will retry next run.`);
        if (runContext.lockManager) {
          runContext.lockManager.release();
        }
        await flushAnalyticsAndExit(0);
      }

      estimationResults.failed++;
      estimationResults.errors.push({
        taskKey,
        error: (error as Error).message,
      });
      console.error(`❌ Failed to estimate ${taskKey}: ${(error as Error).message}`);
      // A failed estimation is a user action that did not complete.
      captureError(error, {
        taskKey,
        tracker: process.env.TASK_TRACKER || "jira",
        stage: "estimate",
      });
      await finishTaskRun("failed", (error as Error).message);
    }
  }

  // Print summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("📊 Estimation Summary:");
  console.log(`   Estimated: ${estimationResults.estimated}`);
  console.log(`   Skipped (< 24h old): ${estimationResults.skipped}`);
  console.log(`   Failed: ${estimationResults.failed}`);

  if (estimationResults.errors.length > 0) {
    console.log("\n❌ Failed estimations:");
    estimationResults.errors.forEach(({ taskKey, error }) => {
      console.log(`   - ${taskKey}: ${error}`);
    });
  }

  // Release lock and exit
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  await flushAnalytics();
  if (estimationResults.failed > 0) {
    await flushErrorTracking();
    process.exit(1);
  }
}

/** Inputs for {@link runTaskBatch}. */
export interface TaskBatchInput {
  activeTrackerType: string;
  tasksToProcess: string[];
  /** Runs one task (the entrypoint supplies `processSingleTask`). */
  runTask: (taskKey: string, index: number, total: number) => Promise<void>;
}

/**
 * Process resolved tasks sequentially, emit the batch summary, and release the
 * run lock. Usage limits abort the remaining batch without failing the run.
 */
export async function runTaskBatch(input: TaskBatchInput): Promise<void> {
  const { activeTrackerType, tasksToProcess, runTask } = input;
  const options = runContext.options;

  const results = {
    total: tasksToProcess.length,
    successful: 0,
    failed: 0,
    errors: [] as Array<{ taskKey: string; error: string }>,
  };

  for (let i = 0; i < tasksToProcess.length; i++) {
    const taskKey = tasksToProcess[i];

    try {
      await runTask(taskKey, i, tasksToProcess.length);
      results.successful++;

      if (i < tasksToProcess.length - 1) {
        console.log("\n" + "=".repeat(80));
        console.log("⏭️  Moving to next task...\n");
      }
    } catch (error) {
      // Usage limit is account-global: abort the remaining batch instead of
      // hammering tasks that would all fail. Exit 0 so the scheduler retries
      // next window without marking the run failed.
      if (error instanceof UsageLimitError) {
        if (isWorkerChild()) {
          if (runContext.lockManager) {
            runContext.lockManager.release();
          }
          writeUsageLimitHint(error);
          await flushAnalyticsAndExit(USAGE_LIMIT_EXIT_CODE);
        }
        const remaining = tasksToProcess.length - i - 1;
        console.warn(
          `\n⏳ ${error.message}. Aborting batch — ${remaining} task(s) left, ` +
            `will resume on the next scheduled run.`,
        );
        if (runContext.lockManager) {
          runContext.lockManager.release();
        }
        await flushAnalyticsAndExit(0);
      }

      results.failed++;
      results.errors.push({
        taskKey,
        error: (error as Error).message,
      });

      console.log("⚠️  Continuing with remaining tasks...\n");
    }
  }

  // One outcome event per interactive run marks the activation funnel's "first
  // successful task" step; worker subprocesses instead report
  // `worker_task_run` so the two paths stay comparable.
  if (!isWorkerTaskProcess() && tasksToProcess.length > 0) {
    await trackInteractiveTaskRun({
      tracker: activeTrackerType,
      outcome: results.failed === 0 ? "succeeded" : results.successful > 0 ? "partial" : "failed",
      taskCount: tasksToProcess.length,
      runMode: options.query ? "query" : "tasks",
    });
  }

  // Print summary for batch operations
  if (tasksToProcess.length > 1) {
    console.log("\n" + "=".repeat(80));
    console.log("📊 Batch Processing Summary:");
    console.log(`   Total tasks: ${results.total}`);
    console.log(`   ✅ Successful: ${results.successful}`);
    console.log(`   ❌ Failed: ${results.failed}`);

    if (results.errors.length > 0) {
      console.log("\n❌ Failed tasks:");
      results.errors.forEach(({ taskKey, error }) => {
        console.log(`   - ${taskKey}: ${error}`);
      });
    }

    if (results.failed > 0) {
      // Release lock before exiting
      if (runContext.lockManager) {
        runContext.lockManager.release();
      }
      await flushAnalytics();
      // Task failures were already captured in processSingleTask; make sure
      // those events are sent before this exit.
      await flushErrorTracking();
      process.exit(1);
    }
  }

  // Release lock on successful completion
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  await flushAnalytics();
}
