import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  buildPromptArgs,
  detectUsageLimit,
  isConstrainedMode,
  reapTree,
  resolveExecutablePathWithRetry,
  spawnAgent,
  UsageLimitError,
} from "@devintern/agent-harness";
import type { AgentHarness, AgentRunOptions } from "@devintern/agent-harness";
import { ReadonlyAnalysisError } from "../agent/analysis-mode";
import { parseAgentJsonObject } from "../agent/json";
import { getSandbox } from "../agent/sandbox";
import { resolveOutputDir } from "../config/output-dir";
import { getStoryPointsFieldForProject } from "../config/project-settings";
import type { TaskTrackerClient } from "../trackers/client";
import type { ProjectSettings } from "../../types/settings";

export interface EstimationResult {
  storyPoints: number; // 1, 2, 3, 5, 8, 13, 21
  confidence: "high" | "medium" | "low";
  implementationConfidence: number; // 0-10 likelihood AI can implement
  reasoning: string;
  risks: string[];
  unclearAreas: string[];
  summary: string;
}

export interface RunEstimationOptions {
  estimationFile: string;
  harness: AgentHarness;
  executablePath: string;
  taskKey: string;
  tracker: TaskTrackerClient;
  settings: ProjectSettings | null;
  skipComments: boolean;
  existingCommentId: string | undefined;
  runOptions: AgentRunOptions;
}

/**
 * Run the agent to estimate story points and update the task tracker (field + comment).
 *
 * @param options - Estimation inputs
 */
export async function runEstimation(
  options: RunEstimationOptions,
): Promise<EstimationResult | null> {
  const {
    estimationFile,
    harness,
    executablePath,
    taskKey,
    tracker,
    settings,
    skipComments,
    existingCommentId,
    runOptions,
  } = options;
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the estimation.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    (async () => {
      if (!existsSync(estimationFile)) {
        reject(new Error(`Estimation file not found: ${estimationFile}`));
        return;
      }

      const estimationContent = readFileSync(estimationFile, "utf8");
      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

      const estimationArgs = harness.buildArgs(runOptions);
      console.log(`📊 Running story points estimation with ${harness.displayName}...`);
      console.log(`   Command: ${executablePath} ${estimationArgs.join(" ")}`);

      let stdoutOutput = "";
      let stderrOutput = "";
      let timedOut = false;
      let usageLimit: ReturnType<typeof detectUsageLimit> | undefined;

      const { child: estimationAgent, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: [...estimationArgs, ...buildPromptArgs(harness, estimationContent)],
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
        sandbox: await getSandbox(harness.name),
      });

      const stopOnUsageLimit = (): void => {
        if (usageLimit?.limited) return;
        const detected = detectUsageLimit(stdoutOutput, stderrOutput);
        if (detected.limited) {
          usageLimit = detected;
          reapTree(estimationAgent, "SIGTERM");
        }
      };

      const timeout = setTimeout(
        () => {
          timedOut = true;
          console.error(
            `\n⏰ ${harness.displayName} estimation timed out after ${timeoutMinutes} minutes, killing...`,
          );
          reapTree(estimationAgent, "SIGTERM");
          setTimeout(() => {
            if (!estimationAgent.killed) {
              reapTree(estimationAgent, "SIGKILL");
            }
            sandboxCleanup().catch(() => {});
          }, 10_000);
        },
        timeoutMinutes * 60 * 1000,
      );

      if (estimationAgent.stdout) {
        estimationAgent.stdout.on("data", (data: Buffer) => {
          stdoutOutput += data.toString();
          stopOnUsageLimit();
        });
      }

      if (estimationAgent.stderr) {
        estimationAgent.stderr.on("data", (data: Buffer) => {
          stderrOutput += data.toString();
          stopOnUsageLimit();
        });
      }

      estimationAgent.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (error.code === "ENOENT") {
          reject(
            new Error(
              `${harness.displayName} CLI not found at: ${executablePath}\nPlease install ${harness.displayName} or specify the correct path with --agent-path`,
            ),
          );
        } else {
          reject(new Error(`Failed to run ${harness.displayName} estimation: ${error.message}`));
        }
      });

      estimationAgent.on("close", async (code: number | null) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});

        if (timedOut) {
          reject(new Error(`Agent estimation timed out after ${timeoutMinutes} minutes`));
          return;
        }

        const usage = usageLimit ?? detectUsageLimit(stdoutOutput, stderrOutput);
        if (usage.limited) {
          if (usage.matchedLine) {
            console.log(`   Matched output: ${usage.matchedLine}`);
          }
          reject(new UsageLimitError(usage.resetsAt));
          return;
        }

        if (code !== 0) {
          reject(new Error(`Agent estimation exited with code ${code}`));
          return;
        }

        try {
          // Parse JSON from Agent's response
          const result = parseEstimationResponse(stdoutOutput);

          console.log(`\n📊 Estimation Result for ${taskKey}:`);
          console.log(`   Story Points: ${result.storyPoints}`);
          console.log(`   Confidence: ${result.confidence}`);
          const implLabel =
            result.implementationConfidence >= 9
              ? "Almost certain"
              : result.implementationConfidence >= 7
                ? "High chance"
                : result.implementationConfidence >= 5
                  ? "May need guidance"
                  : result.implementationConfidence >= 3
                    ? "Significant ambiguity"
                    : "Needs human judgment";
          console.log(`   AI Can Implement: ${result.implementationConfidence}/10 — ${implLabel}`);
          console.log(`   Summary: ${result.summary}`);

          if (result.risks.length > 0) {
            console.log(`   Risks: ${result.risks.join("; ")}`);
          }
          if (result.unclearAreas.length > 0) {
            console.log(`   Unclear Areas: ${result.unclearAreas.join("; ")}`);
          }

          // Discover or use configured estimation field
          const projectKey = taskKey.split("-")[0];
          const configuredField = getStoryPointsFieldForProject(projectKey, settings);
          if (configuredField) {
            console.log(`📊 Using configured story points field: ${configuredField}`);
          }
          const fieldId = configuredField || (await tracker.discoverEstimationField(taskKey));

          // Update story points
          if (fieldId) {
            try {
              await tracker.updateEstimation(taskKey, fieldId, result.storyPoints);
            } catch (updateError) {
              console.warn(`⚠️  Failed to set story points field: ${updateError}`);
            }
          } else {
            console.log("⚠️  No story points field found — skipping field update");
            console.log(
              '   Configure storyPointsField in .devintern-code/settings.json or ensure your tracker has a "Story Points" field',
            );
          }

          // Post or update estimation comment
          if (!skipComments) {
            try {
              if (existingCommentId) {
                await tracker.updateEstimationComment(taskKey, existingCommentId, result);
              } else {
                await tracker.postEstimationComment(taskKey, result);
              }
            } catch (commentError) {
              console.warn(
                `⚠️  Failed to ${existingCommentId ? "update" : "post"} estimation comment: ${commentError}`,
              );
            }
          } else {
            console.log("⏭️  Skipping estimation comment (--skip-comments)");
          }

          // Save estimation result to task directory
          try {
            const baseOutputDir = resolveOutputDir();
            const taskDir = join(baseOutputDir, taskKey.toLowerCase());
            mkdirSync(taskDir, { recursive: true });
            const resultFile = join(taskDir, "estimation-result.json");
            writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf8");
            console.log(`💾 Saved estimation result to: ${resultFile}`);
          } catch (saveError) {
            console.warn(`⚠️  Failed to save estimation result: ${saveError}`);
          }

          resolve(result);
        } catch (parseError) {
          // See runClarityCheck: let the fallback retry read-only failures in
          // default mode instead of counting the task as failed.
          if (isConstrainedMode(runOptions.mode)) {
            reject(
              new ReadonlyAnalysisError(
                `Estimation output unusable in read-only mode: ${parseError}`,
              ),
            );
            return;
          }
          console.warn("Failed to parse estimation response:", parseError);
          console.log("Raw Agent output:", stdoutOutput);
          resolve(null);
        }
      });
    })().catch(reject);
  });
}

/**
 * Parse and validate JSON story-point estimation output from the agent.
 *
 * @param output - Raw agent stdout
 * @throws When JSON is invalid or values are out of range
 */
export function parseEstimationResponse(output: string): EstimationResult {
  const parsed = parseAgentJsonObject(output, "storyPoints");

  // Validate required fields
  const validPoints = [1, 2, 3, 5, 8, 13, 21];
  const storyPoints = parsed.storyPoints;
  if (typeof storyPoints !== "number" || !validPoints.includes(storyPoints)) {
    throw new Error(
      `Invalid story points value: ${storyPoints}. Must be one of: ${validPoints.join(", ")}`,
    );
  }

  const confidence = parsed.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    throw new Error(`Invalid confidence level: ${confidence}. Must be high, medium, or low`);
  }

  // Clamp implementationConfidence to 0-10, default to 5 if missing
  let implConf =
    typeof parsed.implementationConfidence === "number" ? parsed.implementationConfidence : 5;
  implConf = Math.max(0, Math.min(10, Math.round(implConf)));

  return {
    storyPoints,
    confidence,
    implementationConfidence: implConf,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    unclearAreas: Array.isArray(parsed.unclearAreas) ? parsed.unclearAreas : [],
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}
