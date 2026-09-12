import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { basename, join } from "path";
import { UsageLimitError } from "@devintern/agent-harness";
import { isMarkdownFilePath } from "@devintern/task-trackers";
import { captureError, flushErrorTracking } from "@devintern/utils";
import { runAnalysisWithFallback } from "../agent/analysis-mode";
import { runClarityCheck } from "../agent/clarity";
import { runAgentHarness } from "../agent/run-harness";
import { flushAnalyticsAndExit } from "../cli/bootstrap";
import { isWorkerTaskProcess, runContext } from "../cli/context";
import { GitHubAppAuth } from "../code-host/github/app-auth";
import { resolveOutputDir } from "../config/output-dir";
import {
  getActiveTrackerType,
  getInProgressStatusForProject,
  getTodoStatusForProject,
  loadProjectSettings,
  resolveProjectKey,
} from "../config/project-settings";
import { validateEnvironment } from "../config/validate-environment";
import {
  RUN_ORIGIN_ENV,
  flushAnalytics,
  trackInteractiveTaskRun,
} from "../observability/analytics";
import { DEFAULT_AUTO_REVIEW_ITERATIONS } from "../review/auto-review-config";
import { shouldSkipRetry } from "../state/retry-gate";
import { clearRetryState, getRetryState } from "../state/retry-state";
import {
  RunStore,
  beginRun,
  recordRunBranch,
  recordRunStage,
  recordRunTicket,
} from "../state/run-recorder";
import { finishTaskRun } from "../state/task-run";
import { TaskFormatter } from "../task/formatter";
import type { RetryPromptContext } from "../task/formatter";
import { buildTicketUrl } from "../task/ticket-url";
import type { TaskTrackerClient } from "../trackers/client";
import { TaskTrackerManager } from "../trackers/manager";
import { isMarkdownTaskTracker } from "../trackers/markdown/markdown-task-tracker-client";
import type { MarkdownTaskRaw } from "../trackers/markdown/markdown-task-tracker-client";
import { Utils } from "../utils";
import {
  USAGE_LIMIT_EXIT_CODE,
  isWorkerChild,
  writeUsageLimitHint,
} from "../worker/usage-limit-protocol";
import { WORKSPACE_REPO_ENV } from "../workspace/env";
import { reportProcessingFailure } from "./processing-failure";

/** Inputs for {@link runFeasibilityCheck}. */
interface FeasibilityCheckInput {
  taskDetails: ReturnType<TaskTrackerClient["formatTaskDetails"]>;
  workflowKey: string;
  tracker: TaskTrackerClient;
  attachmentMap: Map<string, string> | undefined;
  totalTasks: number;
}

/**
 * Run the pre-implementation feasibility assessment, aborting single-task runs
 * that fail it. Usage limits propagate so the worker can fail over.
 */
async function runFeasibilityCheck(input: FeasibilityCheckInput): Promise<void> {
  const { taskDetails, workflowKey, tracker, attachmentMap, totalTasks } = input;
  const options = runContext.options;
  const resolvedAgent = runContext.resolvedAgent;

  console.log("\n🔍 Running basic feasibility assessment...");
  console.log(
    "   (Checking for fundamental requirements only - technical details will be inferred from code)",
  );

  // Always build the assessment prompt — markdown trackers previously
  // reused task-details.md (an implement prompt), so the agent returned
  // prose instead of the required JSON assessment.
  const clarityInputFile = join(
    require("os").tmpdir(),
    `clarity-${workflowKey.toLowerCase()}-${Date.now()}.md`,
  );
  TaskFormatter.saveClarityAssessment(
    taskDetails,
    clarityInputFile,
    process.env.JIRA_BASE_URL,
    attachmentMap,
  );

  try {
    const assessment = await runAnalysisWithFallback(resolvedAgent.harness, 10, (runOptions) =>
      runClarityCheck(
        clarityInputFile,
        resolvedAgent.harness,
        resolvedAgent.path,
        { key: workflowKey, tracker, skipComments: options.skipComments },
        runOptions,
      ),
    );

    recordRunStage("feasibility", {
      status: assessment ? (assessment.isImplementable ? "succeeded" : "failed") : "skipped",
      summary: assessment?.summary,
      detail: assessment ?? undefined,
    });

    if (assessment && !assessment.isImplementable) {
      if (totalTasks > 1) {
        console.log(
          `\n⚠️  Task ${workflowKey} failed clarity assessment but continuing with batch processing...`,
        );
      } else {
        await finishTaskRun("abandoned", "failed feasibility assessment");
        if (runContext.lockManager) {
          runContext.lockManager.release();
        }
        process.exit(1);
      }
    }

    try {
      require("fs").unlinkSync(clarityInputFile);
    } catch {
      /* ignore */
    }
  } catch (clarityError) {
    // Account-global usage limits must abort the run so the worker can
    // fail over. Swallowing them here used to launch implementation on
    // the same exhausted harness (Grok 402 during the clarity check).
    if (clarityError instanceof UsageLimitError) {
      throw clarityError;
    }
    recordRunStage("feasibility", {
      status: "failed",
      summary: `assessment errored: ${(clarityError as Error).message}`,
    });
    console.warn("⚠️  Feasibility check failed, continuing with implementation:", clarityError);
    console.log("   You can skip feasibility checks with --skip-clarity-check");

    try {
      require("fs").unlinkSync(clarityInputFile);
    } catch {
      /* ignore */
    }
  }
}

/** Inputs for {@link runImplementation}. */
interface ImplementationInput {
  outputFile: string;
  taskDir: string;
  workflowKey: string;
  tracker: TaskTrackerClient;
  task: Awaited<ReturnType<TaskTrackerClient["getTask"]>>;
  taskDetails: ReturnType<TaskTrackerClient["formatTaskDetails"]>;
  effectiveTargetBranch: string;
}

/**
 * Run the agent implementation session for a prepared task, record the
 * implementation stage, and finish the run record.
 */
async function runImplementation(input: ImplementationInput): Promise<void> {
  const { outputFile, taskDir, workflowKey, tracker, task, taskDetails, effectiveTargetBranch } =
    input;
  const options = runContext.options;
  const resolvedAgent = runContext.resolvedAgent;

  // Get GitHub App author info for commits if configured
  let gitAuthor: { name: string; email: string } | undefined;
  if (options.git && options.autoCommit && !process.env.GITHUB_TOKEN) {
    const githubAppAuth = GitHubAppAuth.fromEnvironment();
    if (githubAppAuth) {
      try {
        gitAuthor = await githubAppAuth.getGitAuthor();
        console.log(`🤖 Commits will be authored by: ${gitAuthor.name}`);
      } catch (error) {
        console.warn(`⚠️  Could not get GitHub App author info: ${(error as Error).message}`);
        console.log("   Commits will use local git config instead.");
      }
    }
  }

  if (isMarkdownTaskTracker(tracker)) {
    for (const summaryName of [
      "implementation-summary.md",
      "implementation-summary-incomplete.md",
    ]) {
      try {
        unlinkSync(join(taskDir, summaryName));
      } catch {
        /* not present */
      }
    }
  }

  console.log(`\n🤖 Running ${resolvedAgent.harness.displayName} with task details...`);
  const implementationStartedAt = Date.now();
  await runAgentHarness({
    taskFile: outputFile,
    harness: resolvedAgent.harness,
    executablePath: resolvedAgent.path,
    maxTurns: Number.parseInt(options.maxTurns),
    taskKey: workflowKey,
    taskSummary: taskDetails.summary,
    enableGit: options.git && options.autoCommit,
    task,
    createPr: options.createPr,
    prTargetBranch: effectiveTargetBranch,
    tracker,
    skipComments: options.skipComments,
    hookRetries: Number.parseInt(options.hookRetries),
    gitAuthor,
    autoReview: options.autoReview,
    autoReviewIterations: runContext.autoReviewIterationCap ?? DEFAULT_AUTO_REVIEW_ITERATIONS,
    isPlanRetry: false,
    prTargetBranchExplicit: options.prTargetBranchExplicit,
    requestedPrTargetBranch: options.requestedPrTargetBranch,
  });

  // An incomplete-summary file written during this run means the agent
  // stopped short and handed back to a human (mtime check guards against
  // stale files from earlier attempts in the same task directory).
  const incompleteSummaryPath = join(taskDir, "implementation-summary-incomplete.md");
  const implementationIncomplete =
    existsSync(incompleteSummaryPath) &&
    statSync(incompleteSummaryPath).mtimeMs >= implementationStartedAt;

  // Persist the agent's own report (implementation-summary[-incomplete].md)
  // in the run record: the output directory is an ephemeral debug artifact,
  // and for escalated runs this text is the "why" a human needs.
  const REPORT_EXCERPT_LENGTH = 10_000;
  const reportPath = implementationIncomplete
    ? incompleteSummaryPath
    : join(taskDir, "implementation-summary.md");
  let implementationReport: string | undefined;
  try {
    if (existsSync(reportPath) && statSync(reportPath).mtimeMs >= implementationStartedAt) {
      implementationReport = readFileSync(reportPath, "utf8").slice(0, REPORT_EXCERPT_LENGTH);
    }
  } catch {
    /* best-effort: recording must never fail a run */
  }

  recordRunStage("implementation", {
    status: implementationIncomplete ? "failed" : "succeeded",
    summary: implementationIncomplete
      ? `incomplete implementation with ${resolvedAgent.harness.displayName}`
      : `implemented with ${resolvedAgent.harness.displayName}`,
    detail: {
      harness: resolvedAgent.harness.displayName,
      durationMs: Date.now() - implementationStartedAt,
      ...(implementationReport === undefined ? {} : { report: implementationReport }),
    },
  });

  if (isMarkdownTaskTracker(tracker)) {
    await tracker.markDoneIfSuccessful(workflowKey, taskDir);
  }
  if (implementationIncomplete) {
    await finishTaskRun("escalated", "implementation incomplete; handed back to a human");
  } else {
    await finishTaskRun("succeeded");
    // A later reopen of the ticket starts with a clean retry slate.
    clearRetryState(workflowKey);
  }
  runContext.activeTaskContext = null;
}

/** Identifies the task attempt for failure handling. */
interface TaskAttempt {
  taskKey: string;
  taskIndex: number;
  totalTasks: number;
}

/**
 * Handle a failed task attempt. Usage limits defer without failing the task;
 * other errors record tracker feedback and either rethrow (batch) or exit.
 */
async function handleTaskFailure(error: unknown, attempt: TaskAttempt): Promise<never> {
  const { taskKey, taskIndex, totalTasks } = attempt;
  const options = runContext.options;

  if (error instanceof UsageLimitError) {
    await finishTaskRun("deferred", error.message);
    if (isWorkerChild()) {
      console.warn(`\n⏳ ${error.message}. Signaling worker to fail over.`);
      if (runContext.activeTaskContext?.movedToInProgress) {
        try {
          const todoStatus = getTodoStatusForProject(
            runContext.activeTaskContext.projectKey,
            loadProjectSettings(),
          );
          if (todoStatus?.trim()) {
            await runContext.activeTaskContext.tracker.transitionStatus(taskKey, todoStatus.trim());
          }
        } catch {
          /* best-effort */
        }
      }
      if (runContext.lockManager) {
        runContext.lockManager.release();
      }
      writeUsageLimitHint(error);
      await flushAnalyticsAndExit(USAGE_LIMIT_EXIT_CODE);
    }
    console.warn(`\n⏳ ${error.message}. Stopping; will retry on the next scheduled run.`);
    try {
      await reportProcessingFailure(taskKey, `${error.message} (usage limit)`);
    } catch {
      /* best-effort */
    }
    if (totalTasks > 1) {
      throw error;
    }
    if (runContext.lockManager) {
      runContext.lockManager.release();
    }
    await flushAnalyticsAndExit(0);
  }

  const err = error as Error;
  await finishTaskRun("failed", err.message);
  const taskPrefix = totalTasks > 1 ? `[${taskIndex + 1}/${totalTasks}] ` : "";
  console.error(`${taskPrefix}❌ Error processing ${taskKey}: ${err.message}`);
  if (options.verbose && err.stack) {
    console.error(err.stack);
  }
  captureError(error, {
    taskKey,
    tracker: process.env.TASK_TRACKER || "jira",
    stage: "process-task",
  });

  try {
    await reportProcessingFailure(taskKey, err.message);
  } catch {
    /* best-effort */
  }
  runContext.activeTaskContext = null;

  if (totalTasks > 1) {
    throw error;
  }
  if (!isWorkerTaskProcess()) {
    await trackInteractiveTaskRun({
      tracker: getActiveTrackerType(),
      outcome: "failed",
      taskCount: 1,
      runMode: options.query ? "query" : "tasks",
    });
    await flushAnalytics();
  }
  await flushErrorTracking();
  process.exit(1);
}

/** Resolved task/tracker context for one pipeline run. */
interface PreparedTask {
  taskPrefix: string;
  markdownInput: boolean;
  tracker: TaskTrackerClient;
  task: Awaited<ReturnType<TaskTrackerClient["getTask"]>>;
  workflowKey: string;
  comments: Awaited<ReturnType<TaskTrackerClient["getComments"]>>;
  linkedResources: ReturnType<TaskTrackerClient["extractLinkedResources"]>;
  relatedIssues: Awaited<ReturnType<TaskTrackerClient["getRelatedWorkItems"]>>;
  taskDetails: ReturnType<TaskTrackerClient["formatTaskDetails"]>;
  projectSettings: ReturnType<typeof loadProjectSettings>;
  projectKey: string;
  descriptionText: ReturnType<TaskTrackerClient["extractDescriptionText"]>;
  priorRetryState: ReturnType<typeof getRetryState>;
}

/**
 * Validate the environment, fetch the task and its context, apply the retry
 * gate, and open the run record. Returns `null` when the retry gate skips a
 * batch task; single-task skips exit directly.
 */
async function prepareTask(input: {
  taskKey: string;
  taskIndex: number;
  totalTasks: number;
}): Promise<PreparedTask | null> {
  const { taskKey, taskIndex, totalTasks } = input;
  const options = runContext.options;
  const resolvedAgent = runContext.resolvedAgent;

  const taskPrefix = totalTasks > 1 ? `[${taskIndex + 1}/${totalTasks}] ` : "";
  const markdownInput = isMarkdownFilePath(taskKey);

  if (!markdownInput) {
    await validateEnvironment();
  }

  const tracker = new TaskTrackerManager().getClient(taskKey);

  if (options.verbose && !markdownInput) {
    console.log("📥 Fetching task details...");
  }

  if (!markdownInput) {
    console.log(`${taskPrefix}🔍 Fetching task: ${taskKey}`);
  }

  const task = await tracker.getTask(taskKey);
  const workflowKey = task.key;

  if (markdownInput && isMarkdownTaskTracker(tracker)) {
    const raw = task.raw as MarkdownTaskRaw;
    console.log(`${taskPrefix}📄 Processing markdown file: ${raw.filePath}`);
  }

  // Load project settings to get status transitions
  const projectSettings = loadProjectSettings();
  const projectKey = resolveProjectKey(workflowKey, task);
  runContext.activeTaskContext = {
    taskKey: workflowKey,
    tracker,
    projectKey,
    movedToInProgress: false,
  };

  // Fetch comments before the retry gate: a new comment since the last
  // incomplete attempt counts as a clarification and unlocks a retry.
  if (!isMarkdownTaskTracker(tracker)) {
    console.log("💬 Fetching comments...");
  }
  const comments = await tracker.getComments(workflowKey);
  if (!isMarkdownTaskTracker(tracker)) {
    console.log(`✅ Successfully fetched ${comments.length} comments`);
  }

  const retry = await applyRetryGate({ tracker, task, workflowKey, comments, totalTasks });
  if (!retry) return null;
  const { descriptionText, priorRetryState } = retry;

  // Structured run record for this attempt (skips above are not attempts).
  // Scheduled automations run through this same pipeline with their prompt
  // materialized as a markdown task; env markers attribute those runs.
  // Dashboard "Run now" triggers use the same markers with a `manual`
  // origin so run history distinguishes them from scheduled runs.
  const scheduledAutomationId = process.env.DEVINTERN_AUTOMATION_ID;
  const trackerName = process.env.TASK_TRACKER || "jira";
  const isManualAutomationRun =
    scheduledAutomationId !== undefined && process.env[RUN_ORIGIN_ENV] === "manual";
  const isErrorMonitorRun = process.env[RUN_ORIGIN_ENV] === "error_monitor";
  beginRun({
    origin: scheduledAutomationId
      ? isManualAutomationRun
        ? "manual"
        : "scheduled"
      : isErrorMonitorRun
        ? "error_monitor"
        : "task",
    taskKey: workflowKey,
    tracker: isErrorMonitorRun ? "sentry" : trackerName,
    team: process.env.DEVINTERN_WORKSPACE_TEAM,
    repo: process.env.DEVINTERN_WORKSPACE_REPO,
    // The harness that will implement this run (resolved at startup).
    harness: resolvedAgent.harness.name,
    ...(scheduledAutomationId ? { automationId: scheduledAutomationId } : {}),
    // Ticket link for remote trackers only: markdown-file inputs and
    // materialized automation prompts have no tracker page, and deriving
    // URLs from their synthetic keys would point nowhere.
    ticketUrl:
      markdownInput || scheduledAutomationId ? undefined : buildTicketUrl(trackerName, workflowKey),
  });

  if (!isMarkdownTaskTracker(tracker)) {
    console.log("🔗 Extracting linked resources...");
  }
  const linkedResources = tracker.extractLinkedResources(task);
  if (!isMarkdownTaskTracker(tracker)) {
    console.log(`✅ Successfully extracted ${linkedResources.length} linked resources`);
  }

  if (!isMarkdownTaskTracker(tracker)) {
    console.log("🔗 Fetching related work items...");
  }
  const relatedIssues = await tracker.getRelatedWorkItems(task);
  if (!isMarkdownTaskTracker(tracker)) {
    console.log(`✅ Successfully fetched ${relatedIssues.length} related work items`);
  }

  if (!isMarkdownTaskTracker(tracker)) {
    console.log("📝 Formatting task details...");
    console.log(
      "🔍 Task structure:",
      JSON.stringify(
        {
          key: task.key,
          summary: task.summary,
          issueType: task.issueType,
        },
        null,
        2,
      ),
    );
  }

  let taskDetails;
  try {
    taskDetails = tracker.formatTaskDetails(task, comments, linkedResources, relatedIssues);
    console.log("✅ Successfully formatted task details");
  } catch (formatError) {
    console.error("❌ Error formatting task details:", formatError);
    throw formatError;
  }

  // Snapshot the ticket's description as markdown for the run record so the
  // dashboard shows what was asked even if the ticket changes or is deleted.
  recordRunTicket({
    description: TaskFormatter.buildTaskDescriptionMarkdown(taskDetails),
  });
  return {
    taskPrefix,
    markdownInput,
    tracker,
    task,
    workflowKey,
    comments,
    linkedResources,
    relatedIssues,
    taskDetails,
    projectSettings,
    projectKey,
    descriptionText,
    priorRetryState,
  };
}

/** Result of the retry gate: the state needed downstream when not skipped. */
interface RetryGateResult {
  descriptionText: ReturnType<TaskTrackerClient["extractDescriptionText"]>;
  priorRetryState: ReturnType<typeof getRetryState>;
}

/**
 * Skip an unchanged incomplete task. Returns `null` when the task should be
 * skipped (batch returns, single exits); otherwise returns the retry state.
 */
async function applyRetryGate(input: {
  tracker: TaskTrackerClient;
  task: Awaited<ReturnType<TaskTrackerClient["getTask"]>>;
  workflowKey: string;
  comments: Awaited<ReturnType<TaskTrackerClient["getComments"]>>;
  totalTasks: number;
}): Promise<RetryGateResult | null> {
  const { tracker, task, workflowKey, comments, totalTasks } = input;
  const options = runContext.options;

  // Retry gate: skip only when a previous attempt was reported incomplete
  // and nothing about the ticket has changed since (see lib/retry-gate.ts).
  const descriptionText = tracker.extractDescriptionText(task);
  const priorRetryState = isMarkdownTaskTracker(tracker) ? null : getRetryState(workflowKey);
  if (!isMarkdownTaskTracker(tracker)) {
    console.log("🔍 Checking for previous incomplete implementation attempts...");

    const decision = await shouldSkipRetry({
      taskKey: workflowKey,
      state: priorRetryState,
      description: descriptionText,
      comments,
      tracker,
      force: options.force,
    });

    if (decision.skip) {
      console.log(`\n⏭️  Skipping ${workflowKey} - ${decision.reason}`);
      console.log();

      // For batch processing, just return to continue with next task
      // For single task processing, this will end execution
      if (totalTasks > 1) {
        return null;
      }
      // Release lock before exiting
      if (runContext.lockManager) {
        runContext.lockManager.release();
      }
      process.exit(0);
    }

    if (priorRetryState) {
      console.log(`🔁 Retrying ${workflowKey}: ${decision.reason}`);
    }
  }
  return { descriptionText, priorRetryState };
}

/** Print the fetched task summary and linked/related items. */
function displayTaskSummary(input: {
  taskDetails: ReturnType<TaskTrackerClient["formatTaskDetails"]>;
  tracker: TaskTrackerClient;
  linkedResources: ReturnType<TaskTrackerClient["extractLinkedResources"]>;
  relatedIssues: Awaited<ReturnType<TaskTrackerClient["getRelatedWorkItems"]>>;
  comments: Awaited<ReturnType<TaskTrackerClient["getComments"]>>;
}): void {
  const { taskDetails, tracker, linkedResources, relatedIssues, comments } = input;
  const options = runContext.options;

  // Display summary
  console.log("\n📋 Task Summary:");
  console.log(`   Key: ${taskDetails.key}`);
  console.log(`   Summary: ${taskDetails.summary}`);
  console.log(`   Type: ${taskDetails.issueType}`);
  console.log(`   Status: ${taskDetails.status}`);
  if (!isMarkdownTaskTracker(tracker)) {
    console.log(`   Priority: ${taskDetails.priority || "Not specified"}`);
    console.log(`   Assignee: ${taskDetails.assignee || "Unassigned"}`);
  }

  if (linkedResources.length > 0) {
    console.log(`   Linked Resources: ${linkedResources.length} found`);
    if (options.verbose) {
      linkedResources.forEach((resource) => {
        if (resource.url) {
          console.log(`     - ${resource.description}: ${resource.url}`);
        } else if (resource.issueKey) {
          console.log(`     - ${resource.linkType}: ${resource.issueKey}`);
        }
      });
    }
  }

  if (relatedIssues.length > 0) {
    console.log(`   Related Work Items: ${relatedIssues.length} found`);
    if (options.verbose) {
      relatedIssues.forEach((relatedIssue) => {
        console.log(
          `     - ${relatedIssue.linkType}: ${relatedIssue.key} - ${relatedIssue.summary} (${relatedIssue.status})`,
        );
      });
    }
  }

  if (comments.length > 0) {
    console.log(`   Comments: ${comments.length} found`);
  }
}

/**
 * Resolve the PR target branch: per-task override from the description, else the
 * CLI option, validated against the remote default branch.
 */
async function resolveEffectiveTargetBranch(descriptionText: string | undefined): Promise<string> {
  const options = runContext.options;

  // Extract target branch from task description if present
  // This allows per-task branch targeting via patterns like "Target branch: develop"
  // Falls back to --pr-target-branch CLI option (default: main)
  let effectiveTargetBranch = options.prTargetBranch;
  const extractedBranch = Utils.extractTargetBranch(descriptionText);

  if (extractedBranch) {
    console.log(`   🎯 Detected target branch from description: ${extractedBranch}`);
    if (options.verbose) {
      // Show context around the match for debugging
      const lines = descriptionText?.split("\n") || [];
      const matchingLine = lines.find(
        (line) =>
          line.toLowerCase().includes("target branch") ||
          line.toLowerCase().includes("base branch"),
      );
      if (matchingLine) {
        console.log(
          `      Context: "${matchingLine.substring(0, 100)}${matchingLine.length > 100 ? "..." : ""}"`,
        );
      }
    }
    effectiveTargetBranch = extractedBranch;
  } else {
    console.log(`   🎯 Using target branch: ${effectiveTargetBranch} (from CLI option)`);
  }

  // Validate the target branch actually exists on the remote. A wrong or missing
  // target (e.g. `--pr-target-branch main` on a `master` repo) otherwise makes GitHub
  // reject the PR with "Validation Failed", leaving a pushed branch and no PR. Fall
  // back to the repo's real default branch so the PR target, the feature-branch base,
  // and the auto-review diff base all stay consistent.
  if (
    options.git &&
    !(await Utils.remoteBranchExists(effectiveTargetBranch, { verbose: options.verbose }))
  ) {
    const defaultBranch = await Utils.getMainBranchName();
    if (defaultBranch !== effectiveTargetBranch) {
      console.log(
        `   ⚠️  Target branch '${effectiveTargetBranch}' not found on remote, falling back to '${defaultBranch}'`,
      );
      effectiveTargetBranch = defaultBranch;
    }
  }
  return effectiveTargetBranch;
}

/**
 * Create the task output directory, download direct and embedded attachments,
 * and write the agent prompt file (including retry context when applicable).
 */
async function materializeTaskPrompt(input: {
  task: Awaited<ReturnType<TaskTrackerClient["getTask"]>>;
  taskDetails: ReturnType<TaskTrackerClient["formatTaskDetails"]>;
  tracker: TaskTrackerClient;
  relatedIssues: Awaited<ReturnType<TaskTrackerClient["getRelatedWorkItems"]>>;
  workflowKey: string;
  priorRetryState: ReturnType<typeof getRetryState>;
}): Promise<{ taskDir: string; outputFile: string; attachmentMap: Map<string, string> }> {
  const { task, taskDetails, tracker, relatedIssues, workflowKey, priorRetryState } = input;

  // Create unified task-specific directory structure
  const baseOutputDir = resolveOutputDir();
  const taskDir = join(baseOutputDir, workflowKey.toLowerCase());
  const taskFileName = "task-details.md";

  // Create task directory if it doesn't exist
  mkdirSync(taskDir, { recursive: true });

  const outputFile = join(taskDir, taskFileName);
  const attachmentDir = join(taskDir, "attachments");

  // Download attachments automatically - both direct attachments and embedded ones
  let attachmentMap: Map<string, string> | undefined;

  // First, download direct attachments
  if (taskDetails.attachments.length > 0) {
    console.log(`\n📎 Downloading ${taskDetails.attachments.length} direct attachments...`);
    attachmentMap = await tracker.downloadAttachments(workflowKey, attachmentDir);
  } else {
    attachmentMap = new Map<string, string>();
  }

  if (!isMarkdownTaskTracker(tracker)) {
    console.log("\n🔍 Scanning content for embedded attachments...");
  }
  let allHtmlContent = "";

  // Collect all HTML content from descriptions and comments
  if (taskDetails.renderedDescription) {
    allHtmlContent += taskDetails.renderedDescription;
  }

  // Add comments
  taskDetails.comments.forEach((comment) => {
    if (comment.renderedBody) {
      allHtmlContent += comment.renderedBody;
    }
  });

  // Add related issues HTML content
  relatedIssues.forEach((relatedIssue) => {
    if (relatedIssue.renderedDescription) {
      allHtmlContent += relatedIssue.renderedDescription;
    }
  });

  // Download embedded attachments
  if (allHtmlContent) {
    attachmentMap = await tracker.downloadAttachmentsFromContent(
      allHtmlContent,
      attachmentDir,
      attachmentMap,
    );
  }

  if (attachmentMap.size > 0) {
    console.log(`✅ Downloaded ${attachmentMap.size} total attachments to: ${attachmentDir}`);
  }

  if (isMarkdownTaskTracker(tracker)) {
    tracker.writeAgentPrompt(outputFile, task);
    console.log(`\n💾 Saved task details to: ${outputFile}`);
  } else {
    console.log(`\n💾 Saving formatted task details to: ${outputFile}`);

    // On a retry, tell the agent it is a retry, why the last attempt
    // stopped, and which comments arrived since.
    let retryContext: RetryPromptContext | undefined;
    if (priorRetryState) {
      retryContext = {
        attempt: priorRetryState.attemptCount + 1,
        newSinceMs: priorRetryState.reportedAt,
      };
      try {
        const lastRun = new RunStore()
          .listRuns({ taskKey: workflowKey, limit: 10 })
          .find((run) => run.status === "escalated" || run.status === "failed");
        retryContext.previousFailureSummary = lastRun?.outcomeReason;
      } catch {
        // Prompt context only — proceed without it.
      }
    }

    TaskFormatter.saveFormattedTask(
      taskDetails,
      outputFile,
      process.env.JIRA_BASE_URL!,
      attachmentMap,
      undefined,
      retryContext,
    );
  }
  return { taskDir, outputFile, attachmentMap };
}

/**
 * Create (or resume) the feature branch before the agent runs, and prepare the
 * fleet worktree when one is configured. Exits when branch creation fails.
 */
async function ensureFeatureBranch(input: {
  taskKey: string;
  workflowKey: string;
  effectiveTargetBranch: string;
}): Promise<void> {
  const { taskKey, workflowKey, effectiveTargetBranch } = input;
  const options = runContext.options;

  // Create feature branch before running Agent (unless disabled)
  if (options.git) {
    console.log("\n🌿 Creating feature branch...");
    const branchResult = await Utils.createFeatureBranch(workflowKey, effectiveTargetBranch);

    if (branchResult.success) {
      console.log(`✅ ${branchResult.message}`);
      // Record the actual branch (it can gain an attempt suffix) so the
      // dashboard shows which branch a run worked on.
      recordRunBranch(branchResult.branchName);
    } else {
      // Branch creation failed - this is critical for safety
      console.error(`\n❌ Failed to create feature branch: ${branchResult.message}`);

      if (branchResult.message.includes("uncommitted changes")) {
        console.error("Please commit or stash your changes before running devintern.");
        console.error('You can use: git add . && git commit -m "your commit message"');
      } else {
        console.error(
          "Cannot proceed without a feature branch to prevent accidental commits to main/master.",
        );
        console.error(`\nPlease create a feature branch manually:`);
        console.error(`   git checkout -b feature/${workflowKey.toLowerCase()}`);
        console.error(`\nThen run devintern again with --no-git flag:`);
        console.error(`   devintern ${taskKey} --no-git`);
      }

      await finishTaskRun("abandoned", "feature branch creation failed");
      // Release lock before exiting
      if (runContext.lockManager) {
        runContext.lockManager.release();
      }
      process.exit(1);
    }
  }

  // Fleet worktrees are created at the repository's default branch, while
  // the task may target another base branch. Install only after branch
  // preparation so dependencies match the checkout the agent will inspect.
  // This subprocess already carries the workspace/repo/team environment,
  // including private-registry credentials. The same placement also makes
  // persistent automation worktrees reinstall on every occurrence and keeps
  // dependency directories out of the destructive pre-branch cleanup.
  if (process.env[WORKSPACE_REPO_ENV]) {
    await Utils.prepareWorktreeForAgent(process.cwd());
  }
}

/** Move the task to its In Progress status now that implementation is starting. */
async function transitionToInProgress(input: {
  tracker: TaskTrackerClient;
  task: Awaited<ReturnType<TaskTrackerClient["getTask"]>>;
  workflowKey: string;
  projectSettings: ReturnType<typeof loadProjectSettings>;
  projectKey: string;
}): Promise<void> {
  const { tracker, task, workflowKey, projectSettings, projectKey } = input;
  const options = runContext.options;

  // Transition task to "In Progress" now that we're actually starting implementation
  if (isMarkdownTaskTracker(tracker)) {
    const raw = task.raw as MarkdownTaskRaw;
    if (raw.hasStatusField) {
      try {
        console.log(`\n🔄 Updating status in ${basename(raw.filePath)} to 'In Progress'...`);
        await tracker.transitionStatus(workflowKey, "In Progress");
      } catch (statusError) {
        console.warn(`⚠️  Failed to update status: ${(statusError as Error).message}`);
      }
    }
  } else if (!options.skipComments) {
    const inProgressStatus = getInProgressStatusForProject(projectKey, projectSettings);
    if (inProgressStatus && inProgressStatus.trim()) {
      try {
        console.log(`\n🔄 Transitioning ${workflowKey} to '${inProgressStatus}'...`);
        await tracker.transitionStatus(workflowKey, inProgressStatus.trim());
        console.log(`✅ Task moved to '${inProgressStatus}'`);
        if (runContext.activeTaskContext && runContext.activeTaskContext.taskKey === workflowKey) {
          runContext.activeTaskContext.movedToInProgress = true;
        }
      } catch (statusError) {
        console.warn(
          `⚠️  Failed to transition task to '${inProgressStatus}': ${
            (statusError as Error).message
          }`,
        );
        console.log("   Continuing with task processing...");
      }
    }
  }
}

/**
 * Run the full implementation workflow for one JIRA task key.
 *
 * @param taskKey - JIRA issue key
 * @param taskIndex - Zero-based index in a batch run
 * @param totalTasks - Total tasks in the batch
 */
export async function processSingleTask(
  taskKey: string,
  taskIndex = 0,
  totalTasks = 1,
): Promise<void> {
  const options = runContext.options;
  try {
    const prepared = await prepareTask({ taskKey, taskIndex, totalTasks });
    if (!prepared) return;
    const {
      tracker,
      task,
      workflowKey,
      comments,
      linkedResources,
      relatedIssues,
      taskDetails,
      projectSettings,
      projectKey,
      descriptionText,
      priorRetryState,
    } = prepared;

    displayTaskSummary({ taskDetails, tracker, linkedResources, relatedIssues, comments });

    const effectiveTargetBranch = await resolveEffectiveTargetBranch(descriptionText);

    const { taskDir, outputFile, attachmentMap } = await materializeTaskPrompt({
      task,
      taskDetails,
      tracker,
      relatedIssues,
      workflowKey,
      priorRetryState,
    });

    await ensureFeatureBranch({ taskKey, workflowKey, effectiveTargetBranch });

    // Run clarity check first (unless skipped)
    if (!options.skipClarityCheck) {
      await runFeasibilityCheck({ taskDetails, workflowKey, tracker, attachmentMap, totalTasks });
    }

    await transitionToInProgress({ tracker, task, workflowKey, projectSettings, projectKey });

    await runImplementation({
      outputFile,
      taskDir,
      workflowKey,
      tracker,
      task,
      taskDetails,
      effectiveTargetBranch,
    });
  } catch (error) {
    await handleTaskFailure(error, { taskKey, taskIndex, totalTasks });
  }
}
