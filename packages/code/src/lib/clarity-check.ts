/**
 * Task clarity / feasibility assessment.
 *
 * Extracted from src/index.ts so the pipeline `clarity` step can consume it
 * without importing the CLI entrypoint (which would create an import cycle).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  buildPromptArgs,
  detectMaxTurnsReached,
  reapTree,
  resolveExecutablePathWithRetry,
  spawnAgent,
} from "@devintern/agent-harness";
import type { AgentHarness } from "@devintern/agent-harness";
import { getSandbox } from "./sandbox";
import type { TaskTrackerClient } from "./task-tracker-client";

/** Structured result of the clarity / feasibility assessment. */
export interface ClarityAssessment {
  isImplementable: boolean;
  clarityScore: number;
  issues: Array<{
    category: string;
    description: string;
    severity: "critical" | "major" | "minor";
  }>;
  recommendations: string[];
  summary: string;
}

/**
 * Run the pre-implementation clarity/feasibility assessment for a task.
 *
 * @param clarityFile - Path to the formatted clarity assessment prompt
 * @param harness - Agent harness configuration
 * @param executablePath - Agent CLI executable path
 * @param taskKey - Task tracker issue key
 * @param tracker - Task tracker client for posting assessment comments
 * @param skipComments - Skip posting tracker comments
 * @returns Parsed assessment, or `null` when the response could not be parsed
 */
export async function runClarityCheck(
  clarityFile: string,
  harness: AgentHarness,
  executablePath: string,
  taskKey: string,
  tracker: TaskTrackerClient | undefined,
  skipComments = false,
): Promise<ClarityAssessment | null> {
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the clarity check.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    (async () => {
      // Check if clarity file exists
      if (!existsSync(clarityFile)) {
        reject(new Error(`Clarity assessment file not found: ${clarityFile}`));
        return;
      }

      // Read the clarity assessment content
      const clarityContent = readFileSync(clarityFile, "utf8");

      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

      const clarityArgs = harness.buildArgs({
        maxTurns: 10,
        skipPermissions: true,
        workingDir: process.cwd(),
      });
      console.log(`🔍 Running feasibility assessment with ${harness.displayName}...`);
      console.log(`   Command: ${executablePath} ${clarityArgs.join(" ")}`);
      console.log(`   Input: ${clarityFile}`);

      let stdoutOutput = "";
      let stderrOutput = "";
      let timedOut = false;

      // Spawn agent process for clarity check
      const { child: clarityAgent, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: [...clarityArgs, ...buildPromptArgs(harness, clarityContent)],
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"] },
        sandbox: await getSandbox(harness.name),
      });

      const timeout = setTimeout(
        () => {
          timedOut = true;
          console.error(
            `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
          );
          reapTree(clarityAgent, "SIGTERM");
          setTimeout(() => {
            if (!clarityAgent.killed) {
              reapTree(clarityAgent, "SIGKILL");
            }
          }, 10_000);
        },
        timeoutMinutes * 60 * 1000,
      );

      // Capture stdout for parsing JSON response
      if (clarityAgent.stdout) {
        clarityAgent.stdout.on("data", (data: Buffer) => {
          stdoutOutput += data.toString();
        });
      }

      // Capture stderr for error handling
      if (clarityAgent.stderr) {
        clarityAgent.stderr.on("data", (data: Buffer) => {
          stderrOutput += data.toString();
        });
      }

      // Handle errors
      clarityAgent.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});
        if (error.code === "ENOENT") {
          reject(
            new Error(
              `${harness.displayName} CLI not found at: ${executablePath}\nPlease install ${harness.displayName} or specify the correct path with --agent-path`,
            ),
          );
        } else {
          reject(new Error(`Failed to run ${harness.displayName} clarity check: ${error.message}`));
        }
      });

      // Handle process exit
      clarityAgent.on("close", async (code: number | null) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});
        if (timedOut) {
          reject(
            new Error(
              `${harness.displayName} clarity check timed out after ${timeoutMinutes} minutes`,
            ),
          );
          return;
        }
        if (code === 0) {
          try {
            // Parse the JSON response from agent
            const assessment = parseClarityResponse(stdoutOutput);

            // Save assessment results to task directory for debugging
            try {
              const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
              const taskDir = join(baseOutputDir, taskKey.toLowerCase());
              const assessmentResultFile = join(taskDir, "feasibility-assessment.md");

              // Format assessment as readable markdown
              let assessmentContent = `# Feasibility Assessment Results\n\n`;
              assessmentContent += `**Status**: ${assessment.isImplementable ? "✅ Implementable" : "❌ Not Implementable"}\n`;
              assessmentContent += `**Clarity Score**: ${assessment.clarityScore}/10\n\n`;
              assessmentContent += `## Summary\n\n${assessment.summary}\n\n`;

              if (assessment.issues.length > 0) {
                assessmentContent += `## Issues\n\n`;
                assessment.issues.forEach((issue) => {
                  const severityIcon =
                    issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "🔵";
                  assessmentContent += `### ${severityIcon} ${issue.category} (${issue.severity})\n\n`;
                  assessmentContent += `${issue.description}\n\n`;
                });
              }

              if (assessment.recommendations.length > 0) {
                assessmentContent += `## Recommendations\n\n`;
                assessment.recommendations.forEach((rec, index) => {
                  assessmentContent += `${index + 1}. ${rec}\n`;
                });
                assessmentContent += `\n`;
              }

              // Also save raw JSON for programmatic access
              assessmentContent += `## Raw JSON\n\n\`\`\`json\n${JSON.stringify(assessment, null, 2)}\n\`\`\`\n`;

              writeFileSync(assessmentResultFile, assessmentContent, "utf8");
              console.log(`\n💾 Saved feasibility assessment to: ${assessmentResultFile}`);
            } catch (saveError) {
              console.warn(`⚠️  Failed to save feasibility assessment: ${saveError}`);
            }

            if (assessment.isImplementable) {
              console.log("\n✅ Task feasibility assessment passed");
              console.log(`📊 Clarity Score: ${assessment.clarityScore}/10 (threshold: 4/10)`);
              console.log(`📝 Summary: ${assessment.summary}`);
              if (assessment.clarityScore < 7) {
                console.log("💡 Note: Some details may need to be inferred from existing codebase");
              }

              // Post successful assessment to task tracker as well for feedback
              if (tracker && !skipComments) {
                console.log("\n💬 Posting feasibility assessment to task tracker...");
                await postClarityComment(tracker, taskKey, assessment);
              } else {
                console.log("\n⏭️  Skipping feasibility assessment comment (--skip-comments)");
              }
            } else {
              console.log("\n❌ Task feasibility assessment failed");
              console.log(`📊 Clarity Score: ${assessment.clarityScore}/10 (threshold: 4/10)`);
              console.log(`📝 Summary: ${assessment.summary}`);

              if (assessment.issues.length > 0) {
                console.log("\n🚨 Critical issues identified:");
                assessment.issues.forEach((issue) => {
                  const severityIcon =
                    issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "🔵";
                  console.log(`   ${severityIcon} ${issue.category}: ${issue.description}`);
                });
              }

              if (assessment.recommendations.length > 0) {
                console.log("\n💡 Recommendations:");
                assessment.recommendations.forEach((rec, index) => {
                  console.log(`   ${index + 1}. ${rec}`);
                });
              }

              // Post comment to task tracker with clarity issues
              if (tracker && !skipComments) {
                await postClarityComment(tracker, taskKey, assessment);
              } else {
                console.log("\n⏭️  Skipping failed assessment comment (--skip-comments)");
              }

              console.log("\n🛑 Stopping execution - fundamental requirements unclear");
              console.log("   Please address the critical issues and run again");
              console.log("   Or use --skip-clarity-check to bypass this assessment");
            }

            resolve(assessment);
          } catch (parseError) {
            console.warn("Failed to parse clarity assessment response:", parseError);
            console.log("Raw Agent output:", stdoutOutput);

            // Save failed assessment output for debugging
            try {
              const baseOutputDir = process.env.DEVINTERN_OUTPUT_DIR || "/tmp/devintern-tasks";
              const taskDir = join(baseOutputDir, taskKey.toLowerCase());
              const failedAssessmentFile = join(taskDir, "feasibility-assessment-failed.txt");

              writeFileSync(failedAssessmentFile, stdoutOutput, "utf8");
              console.log(`\n💾 Saved failed assessment output to: ${failedAssessmentFile}`);
            } catch (saveError) {
              console.warn(`⚠️  Failed to save assessment output: ${saveError}`);
            }

            // Check if Agent reached max turns or had other issues
            if (detectMaxTurnsReached(stdoutOutput, stderrOutput)) {
              console.log("\n⚠️  Clarity assessment reached maximum conversation turns");
              console.log("   This may indicate task complexity or insufficient details");
              if (!skipComments) {
                console.log(
                  "   Will attempt to proceed with implementation but posting failure to task tracker...\n",
                );

                // Post assessment failure to task tracker
                try {
                  if (tracker)
                    await postAssessmentFailure(tracker, taskKey, "max-turns", stdoutOutput);
                } catch (trackerError) {
                  console.warn("Failed to post assessment failure to task tracker:", trackerError);
                }
              } else {
                console.log(
                  "   Will attempt to proceed with implementation (skipping tracker comment)...\n",
                );
              }
            } else {
              console.log("\n⚠️  Could not parse clarity assessment response");
              if (!skipComments) {
                console.log(
                  "   Will attempt to proceed with implementation but posting failure to task tracker...\n",
                );

                // Post assessment failure to task tracker
                try {
                  if (tracker)
                    await postAssessmentFailure(tracker, taskKey, "parse-error", stdoutOutput);
                } catch (trackerError) {
                  console.warn("Failed to post assessment failure to task tracker:", trackerError);
                }
              } else {
                console.log(
                  "   Will attempt to proceed with implementation (skipping tracker comment)...\n",
                );
              }
            }

            resolve(null); // Continue with implementation if parsing fails
          }
        } else {
          reject(new Error(`Agent clarity check exited with code ${code}`));
        }
      });
    })().catch(reject);
  });
}

/**
 * Parse JSON clarity assessment output from the agent.
 *
 * @param output - Raw agent stdout
 * @throws When JSON is missing or required fields are invalid
 */
export function parseClarityResponse(output: string): ClarityAssessment {
  // Extract JSON from Agent's response
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // Provide more specific error based on output content
    if (detectMaxTurnsReached(output, "")) {
      throw new Error("warn: Agent reached max turns - no JSON assessment available");
    }
    if (output.trim().length === 0) {
      throw new Error("warn: Empty response from Agent");
    }
    throw new Error("warn: No JSON found in Agent response");
  }

  try {
    const assessment = JSON.parse(jsonMatch[1]);

    // Validate required fields
    if (
      typeof assessment.isImplementable !== "boolean" ||
      typeof assessment.clarityScore !== "number" ||
      !Array.isArray(assessment.issues) ||
      !Array.isArray(assessment.recommendations) ||
      typeof assessment.summary !== "string"
    ) {
      throw new Error("warn: Invalid assessment structure - missing required fields");
    }

    return assessment;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`warn: Malformed JSON in Agent response: ${error.message}`);
    }
    throw new Error(`warn: Failed to parse assessment: ${error}`);
  }
}

/**
 * Post a task tracker comment when clarity assessment fails (max turns or parse error).
 *
 * @param tracker - Task tracker client
 * @param taskKey - Task tracker issue key
 * @param failureType - Failure reason category
 * @param rawOutput - Raw agent output
 */
export async function postAssessmentFailure(
  tracker: TaskTrackerClient,
  taskKey: string,
  failureType: "max-turns" | "parse-error",
  rawOutput: string,
): Promise<void> {
  try {
    await tracker.postAssessmentFailure(taskKey, failureType, rawOutput);
  } catch (error) {
    console.warn("Failed to post assessment failure:", error);
  }
}

/**
 * Post a clarity assessment comment to the task tracker when the check passes thresholds.
 *
 * @param tracker - Task tracker client
 * @param taskKey - Task tracker issue key
 * @param assessment - Parsed clarity assessment
 */
export async function postClarityComment(
  tracker: TaskTrackerClient,
  taskKey: string,
  assessment: ClarityAssessment,
): Promise<void> {
  try {
    await tracker.postClarityComment(taskKey, assessment);
  } catch (error) {
    console.warn("Failed to post clarity comment:", error);
  }
}
