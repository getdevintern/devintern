#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { checkLicense } from "@devintern/license-check";
import {
  resolveHarness,
  resolveExecutablePathStrict,
  UsageLimitError,
} from "@devintern/agent-harness";
import type { ResolvedHarness } from "@devintern/agent-harness";
import { setSandboxOverride } from "./lib/agent/sandbox";
import { initSentryOnce } from "./lib/observability/sentry-init";
import { isMarkdownFilePath } from "@devintern/task-trackers";
import { captureError, flushErrorTracking } from "@devintern/utils";
import {
  flushAnalytics,
  isAnonymousIdNewlyCreated,
  RUN_ORIGIN_ENV,
  track,
  trackInteractiveTaskRun,
} from "./lib/observability/analytics";
import type { AnalyticsPropValue } from "./lib/observability/analytics";
import { runAnalysisWithFallback } from "./lib/agent/analysis-mode";
import {
  DEFAULT_AUTO_REVIEW_ITERATIONS,
  resolveAutoReviewIterations,
} from "./lib/review/auto-review-config";
import { TaskFormatter } from "./lib/task/formatter";
import type { RetryPromptContext } from "./lib/task/formatter";
import { resolveOutputDir } from "./lib/config/output-dir";
import { GitHubAppAuth } from "./lib/code-host/github/app-auth";
import { ensureTrackerEnvConfigured } from "./lib/init/first-run";
import { TaskTrackerManager } from "./lib/trackers/manager";
import type { TaskTrackerClient } from "./lib/trackers/client";
import { JiraTaskTrackerClient } from "./lib/trackers/jira/jira-task-tracker-client";
import { isMarkdownTaskTracker } from "./lib/trackers/markdown/markdown-task-tracker-client";
import type { MarkdownTaskRaw } from "./lib/trackers/markdown/markdown-task-tracker-client";
import {
  supportsEstimate,
  supportsQuery,
  trackersSupportingEstimate,
  trackersSupportingQuery,
} from "./lib/trackers/capabilities";
import { LockManager } from "./lib/lock-manager";
import {
  RunStore,
  beginRun,
  recordRunBranch,
  recordRunStage,
  recordRunTicket,
} from "./lib/state/run-recorder";
import { buildTicketUrl } from "./lib/task/ticket-url";
import { clearRetryState, getRetryState } from "./lib/state/retry-state";
import { shouldSkipRetry } from "./lib/state/retry-gate";
import { reportTaskFailure } from "./lib/task/failure-feedback";
import {
  isWorkerChild,
  USAGE_LIMIT_EXIT_CODE,
  writeUsageLimitHint,
} from "./lib/worker/usage-limit-protocol";
import { Utils } from "./lib/utils";
import { WORKSPACE_REPO_ENV } from "./lib/workspace/env";
import { isAutomatedEnvironment } from "./lib/config/env-detector";
import {
  VERSION,
  checkForCliUpdate,
  enforceLicenseOrExit,
  flushAnalyticsAndExit,
  getLoadedEnvPath,
  loadEnvironment,
  loadSupabaseConfig,
  migrateLegacyConfigDir,
  setEnvironmentEntryDir,
} from "./lib/cli/bootstrap";
import { isSubcommandCommand, createProgram } from "./lib/cli/program";
import type { ProgramOptions } from "./lib/cli/program";
import {
  getActiveTrackerType,
  getInProgressStatusForProject,
  getTodoStatusForProject,
  loadProjectSettings,
  resolveProjectKey,
} from "./lib/config/project-settings";
import { validateEnvironment } from "./lib/config/validate-environment";
import { isWorkerTaskProcess, runContext } from "./lib/cli/context";
import { runEstimationBatch, resolveRunTargets, runTaskBatch } from "./lib/cli/run";
import { finishTaskRun } from "./lib/state/task-run";
import { runClarityCheck } from "./lib/agent/clarity";
import { runAgentHarness } from "./lib/agent/run-harness";
import { runInitCommand } from "./lib/init/cli";
import { runWorkerCli } from "./lib/worker/cli";
import { runDashboardCommand, runDoctorCommand } from "./lib/observability/cli";
import { runWebhookCommand } from "./lib/code-host/cli";
import { runAddressReviewCommand, runResolveConflictsCommand } from "./lib/review/cli";
import { runLoginCommand, runLogoutCommand, runWhoamiCommand } from "./lib/account/cli";
import { runSandboxCommand } from "./lib/agent/cli";

// Get the directory of this script at runtime (works in both ESM and bundled environments)
const __filename_resolved = fileURLToPath(import.meta.url);
const __dirname_resolved = dirname(__filename_resolved);
setEnvironmentEntryDir(__dirname_resolved);

const KNOWN_SANDBOX_PROVIDERS = new Set([
  "none",
  "auto",
  "native",
  "nono",
  "srt",
  "docker",
  "smolvm",
]);

/** Allowlisted, non-identifying props for the `cli_run` analytics event. */
function buildCliRunProps(tracker: string): Record<string, AnalyticsPropValue | undefined> {
  const sandboxProvider = options.sandbox ?? process.env.AGENT_SANDBOX;
  return {
    cli_version: VERSION,
    os: process.platform,
    arch: process.arch,
    ci: isAutomatedEnvironment(),
    tracker,
    run_mode: options.estimate ? "estimate" : options.query ? "query" : "tasks",
    task_count: options.query ? undefined : taskKeys.length,
    create_pr: options.createPr === true,
    auto_review: options.autoReview === true,
    estimate: options.estimate === true,
    sandbox: KNOWN_SANDBOX_PROVIDERS.has(sandboxProvider ?? "") ? sandboxProvider : undefined,
  };
}

// Sentry error tracking — uses the baked-in DevIntern DSN unless SENTRY_DISABLED=1.
// Shared entry-point init (worker/webhook standalone reuse this too); call sites
// pass the release so standalone entries stay attributed to the CLI version.

// Migrate legacy config directory on startup
migrateLegacyConfigDir();

// Check npm for a newer global install before any real work. Local/monorepo
// runs and --help/--version/--no-update are no-ops inside maybeOfferCliUpdate.
await checkForCliUpdate();

// Check if running subcommands before parsing
// This needs to happen early to avoid Commander treating them as task keys
if (process.argv[2] === "init") {
  await runInitCommand();
} else if (process.argv[2] === "worker") {
  // Handle worker command - long-running workspace daemon.
  await runWorkerCli(process.argv.slice(3));
} else if (process.argv[2] === "workspace") {
  console.error("❌ Unknown command: workspace");
  console.error("   Workspace setup and management live under `devintern worker`.");
  console.error("   Run `devintern worker --help` for available commands.");
  process.exit(1);
} else if (process.argv[2] === "dashboard") {
  await runDashboardCommand(process.argv.slice(3));
} else if (process.argv[2] === "webhook") {
  await runWebhookCommand(process.argv.slice(3));
} else if (process.argv[2] === "address-review") {
  await runAddressReviewCommand(process.argv.slice(3));
} else if (process.argv[2] === "resolve-conflicts") {
  await runResolveConflictsCommand(process.argv.slice(3));
} else if (process.argv[2] === "login") {
  await runLoginCommand(process.argv);
} else if (process.argv[2] === "logout") {
  await runLogoutCommand();
} else if (process.argv[2] === "sandbox") {
  await runSandboxCommand();
} else if (process.argv[2] === "doctor") {
  await runDoctorCommand();
} else if (process.argv[2] === "whoami") {
  await runWhoamiCommand();
} else {
  // Load environment variables early (before CLI parsing)
  loadEnvironment();
}

/**
 * Resolve the configured agent harness and normalize its executable path.
 *
 * @param providedPath - Optional CLI path override from flags
 */
function resolveAgentHarness(providedPath?: string): ResolvedHarness {
  const harness = resolveHarness({ cliPath: providedPath });
  harness.path = resolveExecutablePathStrict(harness.path, harness.harness.displayName);
  return harness;
}

// Configure CLI
const program = createProgram();

// Only parse with Commander if we're not running a subcommand
const isSubcommand = isSubcommandCommand(process.argv[2]);
if (!isSubcommand) {
  program.parse();
}

const options = isSubcommand ? ({} as ProgramOptions) : program.opts<ProgramOptions>();
const taskKeys = isSubcommand ? [] : program.args;

runContext.options = options;

if (options.sandbox) {
  setSandboxOverride(options.sandbox);
}

// Map deprecated options to their canonical equivalents
if (options.jql && !options.query) {
  process.stderr.write("⚠️  --jql is deprecated, use --query instead\n");
  options.query = options.jql;
}
if (options.skipJiraComments && !options.skipComments) {
  process.stderr.write("⚠️  --skip-jira-comments is deprecated, use --skip-comments instead\n");
  options.skipComments = true;
}

// Reload environment variables if custom env file was specified
if (options.envFile) {
  loadEnvironment(options.envFile);
} else if (options.verbose) {
  const envPath = getLoadedEnvPath();
  if (envPath) {
    console.log(`📁 Loaded environment from: ${envPath}`);
  } else {
    console.log("⚠️  No .env file found in standard locations");
    console.log("   Searched upward from current directory, then home and package directories.");
  }
}

// Resolve the unified auto-review iteration cap up front so an invalid
// --auto-review-iterations value or AUTO_REVIEW_ITERATIONS env var fails fast
// with a clear error instead of starting agent runs the loop would then
// abort. When auto-review is off the cap is unused and the env var is ignored.
const autoReviewIterationCap: number | undefined = (() => {
  if (options.autoReviewIterations === undefined && !options.autoReview) {
    return undefined;
  }
  try {
    return resolveAutoReviewIterations(options.autoReviewIterations);
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  }
})();

// Resolve the final agent harness
const resolvedAgent = resolveAgentHarness(options.agentPath || options.claudePath);
runContext.resolvedAgent = resolvedAgent;
if (options.verbose) {
  console.log(`🤖 ${resolvedAgent.harness.displayName} resolved to: ${resolvedAgent.path}`);
}

/**
 * Best-effort failure feedback: post a comment explaining why no pull request
 * was created and move the ticket back to its To Do status so the next
 * scheduled run can retry. Never throws — feedback must not mask the
 * original error.
 *
 * After posting, the attempt is recorded for the retry gate so posting the
 * comment (which bumps the ticket's `updated` stamp) does not itself cause
 * an immediate re-pickup loop.
 */
async function reportProcessingFailure(taskKey: string, reason: string): Promise<void> {
  const context = runContext.activeTaskContext;
  if (!context || options.skipComments || isMarkdownFilePath(taskKey)) return;

  await reportTaskFailure({
    taskKey,
    reason,
    tracker: context.tracker,
    trackerType: process.env.TASK_TRACKER || "jira",
    projectKey: context.projectKey,
    movedToInProgress: context.movedToInProgress,
    getTodoStatus: () => getTodoStatusForProject(context.projectKey, loadProjectSettings()),
    log: console.log,
    warn: console.warn,
  });
}

/**
 * Run the full implementation workflow for one JIRA task key.
 *
 * @param taskKey - JIRA issue key
 * @param taskIndex - Zero-based index in a batch run
 * @param totalTasks - Total tasks in the batch
 */
// oxlint-disable-next-line complexity, max-statements -- end-to-end single-task pipeline (fetch → branch → agent → commit → PR → Jira transition) welded to module-level `runContext.activeTaskContext`/`options`; remedy: thread an explicit `TaskRunContext` and split fetch/execute/finalize phases.
async function processSingleTask(taskKey: string, taskIndex = 0, totalTasks = 1): Promise<void> {
  try {
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
          return;
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
        markdownInput || scheduledAutomationId
          ? undefined
          : buildTicketUrl(trackerName, workflowKey),
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

    // Run clarity check first (unless skipped)
    if (!options.skipClarityCheck) {
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
          if (
            runContext.activeTaskContext &&
            runContext.activeTaskContext.taskKey === workflowKey
          ) {
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
      autoReviewIterations: autoReviewIterationCap ?? DEFAULT_AUTO_REVIEW_ITERATIONS,
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
  } catch (error) {
    // Usage limit: don't treat as a task failure. Propagate in batch so the
    // loop aborts the remaining tasks; for a single task, exit 0 (no-op).
    if (error instanceof UsageLimitError) {
      await finishTaskRun("deferred", error.message);
      if (isWorkerChild()) {
        console.warn(`\n⏳ ${error.message}. Signaling worker to fail over.`);
        // Hand the ticket back to To Do without a failure comment so the
        // incomplete-attempt gate cannot strand it, and the parent can retry
        // on the next harness (or pick it up again once a window elapses).
        if (runContext.activeTaskContext?.movedToInProgress) {
          try {
            const todoStatus = getTodoStatusForProject(
              runContext.activeTaskContext.projectKey,
              loadProjectSettings(),
            );
            if (todoStatus?.trim()) {
              await runContext.activeTaskContext.tracker.transitionStatus(
                taskKey,
                todoStatus.trim(),
              );
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
      // The ticket may already be "In Progress": leave feedback and move it
      // back so the deferred retry can actually pick it up.
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
    // A failed task run interrupted a user action — report it with the task
    // context so Sentry shows which pipeline stage is failing for users.
    captureError(error, {
      taskKey,
      tracker: process.env.TASK_TRACKER || "jira",
      stage: "process-task",
    });

    // Leave feedback on the ticket so a failed run never ends silently with
    // the task stranded in "In Progress" and no PR.
    try {
      await reportProcessingFailure(taskKey, err.message);
    } catch {
      /* best-effort */
    }
    runContext.activeTaskContext = null;

    // For batch processing, throw the error to be handled by the main function
    // For single task processing, exit immediately
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
}

/** CLI entry: parse args, acquire lock, and process task key(s) or JQL results. */
async function main(): Promise<void> {
  try {
    initSentryOnce(`code@${VERSION}`);

    // Acquire lock to prevent multiple instances
    runContext.lockManager = new LockManager();
    const lockResult = runContext.lockManager.acquire();

    if (!lockResult.success) {
      console.error(`❌ ${lockResult.message}`);
      console.error("   Please wait for the other instance to complete or stop it manually.");
      if (lockResult.pid) {
        console.error(`   You can stop the other instance with: kill ${lockResult.pid}`);
      }
      process.exit(1);
    }

    // Check for flags that require specific tracker support before env validation
    const activeTrackerType = (process.env.TASK_TRACKER || "jira").toLowerCase();
    if (options.query && !supportsQuery(activeTrackerType)) {
      console.error(
        `❌ Error: --query is not supported for the '${activeTrackerType}' task tracker. ` +
          `Trackers with query support: ${trackersSupportingQuery().join(", ")}.`,
      );
      process.exit(1);
    }
    if (options.estimate && !supportsEstimate(activeTrackerType)) {
      console.error(
        `❌ Error: --estimate is not supported for the '${activeTrackerType}' task tracker. ` +
          `Trackers with estimation support: ${trackersSupportingEstimate().join(", ")}.`,
      );
      process.exit(1);
    }

    // Anonymous usage analytics (PostHog). Fire-and-forget; never blocks or
    // fails the run. Opt out via DEVINTERN_TELEMETRY_DISABLED=1 or
    // analytics.enabled: false in .devintern-code/settings.json.
    if (!isWorkerTaskProcess()) {
      const firstTelemetryRun = isAnonymousIdNewlyCreated();
      void track("cli_run", buildCliRunProps(activeTrackerType));
      if (firstTelemetryRun && !isAutomatedEnvironment()) {
        console.log(
          "ℹ️  devintern collects anonymous usage stats (never task content, code, or credentials)." +
            "\n   Disable with DEVINTERN_TELEMETRY_DISABLED=1 — see https://devintern.com/privacy/",
        );
      }
    }

    // Validate environment — skip when every argument is a local markdown file path
    // (those tasks need no PM credentials). With missing credentials in an
    // interactive terminal, offer the setup wizard inline before failing.
    const needsTrackerEnv = options.query || taskKeys.some((k) => !isMarkdownFilePath(k));
    if (needsTrackerEnv) {
      const firstRun = await ensureTrackerEnvConfigured({
        automated: isAutomatedEnvironment(),
        reloadEnv: () => {
          loadEnvironment(options.envFile);
        },
      });
      if (firstRun === "failed") {
        await validateEnvironment();
      }
    }

    // License check — interactive use is free under FSL; only unattended
    // execution (systemd, cron, CI) requires an automation license.
    if (isAutomatedEnvironment()) {
      const supabaseConfig = loadSupabaseConfig();
      const licenseResult = await checkLicense({
        productKey: "devintern/code",
        supabaseConfig,
        requireAutomation: true,
      });
      await enforceLicenseOrExit(licenseResult);
    }

    // Pull latest changes from remote (unless git is disabled)
    if (options.git) {
      const prTargetBranchSource = program.getOptionValueSource("prTargetBranch");
      options.prTargetBranchExplicit = prTargetBranchSource !== "default";
      options.requestedPrTargetBranch = options.prTargetBranchExplicit
        ? options.prTargetBranch
        : undefined;
      if (prTargetBranchSource === "default") {
        options.prTargetBranch = await Utils.getMainBranchName();
        console.log(`   Default branch detected as '${options.prTargetBranch}'`);
      } else {
        const requestedBranch = options.prTargetBranch;
        options.prTargetBranch = await Utils.resolveDefaultBranch(requestedBranch);
        if (options.prTargetBranch !== requestedBranch) {
          console.log(
            `⚠️  Target branch '${requestedBranch}' not found on remote, falling back to '${options.prTargetBranch}'`,
          );
        }
      }

      console.log("\n📥 Pulling latest changes from remote...");
      const pullResult = await Utils.pullLatestChanges(options.prTargetBranch, {
        verbose: options.verbose,
      });

      if (pullResult.success) {
        console.log(`✅ ${pullResult.message}`);
      } else {
        // Don't fail the entire workflow if pull fails - just warn the user
        console.log(`⚠️  ${pullResult.message}`);
        console.log("   Continuing without pulling latest changes...");
        console.log("   You may want to pull manually before processing tasks.\n");
      }
    }

    const tasksToProcess = await resolveRunTargets(taskKeys, activeTrackerType);
    if (!tasksToProcess) return;

    // Estimation mode: separate code path
    if (options.estimate) {
      await runEstimationBatch({ activeTrackerType, tasksToProcess });
      return;
    }

    // Process tasks sequentially
    await runTaskBatch({
      activeTrackerType,
      tasksToProcess,
      runTask: processSingleTask,
    });
  } catch (error) {
    const err = error as Error;
    console.error(`❌ Error: ${err.message}`);
    if (options.verbose && err.stack) {
      console.error(err.stack);
    }
    // Setup/query failures that reach here were not captured by the per-task
    // handlers (lock, tracker query, license, ...).
    captureError(error, { stage: "main" });
    // Release lock before exiting on error
    if (runContext.lockManager) {
      runContext.lockManager.release();
    }
    await flushAnalytics();
    await flushErrorTracking();
    process.exit(1);
  }
}

// Handle uncaught errors
process.on("unhandledRejection", (error: Error) => {
  console.error("❌ Unhandled error:", error.message);
  if (options.verbose && error.stack) {
    console.error(error.stack);
  }
  captureError(error);
  // Release lock before exiting
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  void Promise.all([flushErrorTracking(), flushAnalytics()]).finally(() => process.exit(1));
});

// Handle process termination signals
let shuttingDown = false;

async function gracefulShutdown(signal: "SIGINT" | "SIGTERM", exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n\n⚠️  Received ${signal}, cleaning up...`);
  // If a task is mid-flight, tell the tracker it was interrupted instead of
  // leaving it silently in "In Progress" with no PR and no feedback.
  const context = runContext.activeTaskContext;
  if (context) {
    // Bound the feedback attempt so tracker I/O can never stall shutdown.
    const shutdownTimer = setTimeout(() => process.exit(exitCode), 15_000);
    try {
      await reportProcessingFailure(
        context.taskKey,
        `Processing was interrupted (${signal}) before a pull request could be created`,
      );
    } catch {
      /* best-effort: never block shutdown on tracker I/O */
    }
    clearTimeout(shutdownTimer);
  }
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  // Bounded; pending crash/handled-error and queued analytics events get a
  // chance to send before the process is torn down.
  await flushAnalytics();
  await flushErrorTracking();
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT", 130); // Standard exit code for SIGINT
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM", 143); // Standard exit code for SIGTERM
});

// Handle uncaught exceptions
process.on("uncaughtException", (error: Error) => {
  console.error("❌ Uncaught exception:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  captureError(error);
  // Release lock before exiting
  if (runContext.lockManager) {
    runContext.lockManager.release();
  }
  void Promise.all([flushErrorTracking(), flushAnalytics()]).finally(() => process.exit(1));
});

// Run the main function (only if not running a subcommand)
if (require.main === module && !isSubcommand) {
  main();
}

export {
  main,
  JiraTaskTrackerClient,
  JiraTaskTrackerClient as JiraClient,
  TaskFormatter,
  TaskTrackerManager,
};
export type { TaskTrackerClient };
