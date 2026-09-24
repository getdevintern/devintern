import { readFileSync } from "fs";
import {
  detectMaxTurnsReached,
  detectUsageLimit,
  findMaxTurnsReachedLine,
  reapTree,
  resolveExecutablePathWithRetry,
  spawnAgent,
} from "@devintern/agent-harness";
import { HEADLESS_AGENT_STDIO, buildHeadlessAgentArgs } from "../agent/spawn";
import { resolveAgentEffort, resolveAgentModel } from "../agent/model";
import { getSandbox } from "../agent/sandbox";

import { resolveActiveHarness } from "./runtime";

/**
 * Spawn the agent harness to address review feedback from a prompt file.
 *
 * @param promptFile - Path to markdown prompt (read and passed via argv)
 * @param workDir - Git working directory
 */
export async function runAgentHarnessForReview(
  promptFile: string,
  workDir: string,
): Promise<{
  success: boolean;
  message: string;
  output?: string;
  maxTurnsReached?: boolean;
  usageLimited?: boolean;
  usageResetHint?: string;
}> {
  const { harness, path: executablePath } = resolveActiveHarness();
  // Wait out any in-progress CLI auto-update swap before spawning, so a
  // transient `spawn ENOENT` doesn't abort the review.
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    cwd: workDir,
    displayName: harness.displayName,
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: Parameters<typeof resolve>[0]): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    (async () => {
      const maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "500", 10);

      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);
      const promptContent = readFileSync(promptFile, "utf8");
      const runOptions = {
        maxTurns,
        skipPermissions: true,
        workingDir: workDir,
        model: resolveAgentModel(),
        effort: resolveAgentEffort(),
      };
      const agentArgs = buildHeadlessAgentArgs(harness, promptContent, runOptions);

      console.log(`   Command: ${resolvedPath} ${harness.buildArgs(runOptions).join(" ")}`);
      console.log(`   Timeout: ${timeoutMinutes} minutes`);

      let stdoutOutput = "";
      let stderrOutput = "";
      let timedOut = false;
      let usageLimit: ReturnType<typeof detectUsageLimit> | undefined;

      const { child: agent, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: agentArgs,
        spawnOptions: { cwd: workDir, stdio: HEADLESS_AGENT_STDIO },
        sandbox: await getSandbox(harness.name),
      });

      const stopOnUsageLimit = (): void => {
        if (usageLimit?.limited) return;
        const detected = detectUsageLimit(stdoutOutput, stderrOutput);
        if (detected.limited) {
          usageLimit = detected;
          reapTree(agent, "SIGTERM");
        }
      };

      const timeout = setTimeout(
        () => {
          timedOut = true;
          console.error(
            `\n⏰ ${harness.displayName} process timed out after ${timeoutMinutes} minutes, killing...`,
          );
          reapTree(agent, "SIGTERM");
          // Force kill the whole group after 10 seconds if SIGTERM doesn't work
          setTimeout(() => {
            if (!agent.killed) {
              reapTree(agent, "SIGKILL");
            }
            sandboxCleanup().catch(() => {});
          }, 10_000);
        },
        timeoutMinutes * 60 * 1000,
      );

      if (agent.stdout) {
        agent.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          stdoutOutput += output;
          stopOnUsageLimit();
          process.stdout.write(output);
        });
      }

      if (agent.stderr) {
        agent.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          stderrOutput += output;
          stopOnUsageLimit();
          process.stderr.write(output);
        });
      }

      agent.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        settle({
          success: false,
          message: `Failed to run Agent: ${error.message}`,
        });
      });

      agent.on("close", (code: number | null) => {
        clearTimeout(timeout);
        sandboxCleanup().catch(() => {});
        const maxTurnsReached = detectMaxTurnsReached(
          stdoutOutput,
          stderrOutput,
          harness.supportsMaxTurns === true,
        );
        const usage = usageLimit ?? detectUsageLimit(stdoutOutput, stderrOutput);
        const output = stdoutOutput + stderrOutput;

        if (timedOut) {
          settle({
            success: false,
            message: `Agent timed out after ${timeoutMinutes} minutes`,
            output,
            maxTurnsReached,
          });
        } else if (usage.limited) {
          if (usage.matchedLine) {
            console.log(`   Matched output: ${usage.matchedLine}`);
          }
          // A usage/rate limit is account-global — surface it so the caller can
          // pause the queue until reset rather than treating it as a task failure.
          settle({
            success: false,
            message: `Agent hit a usage limit${usage.resetsAt ? ` (resets ${usage.resetsAt})` : ""}`,
            output,
            usageLimited: true,
            usageResetHint: usage.resetsAt,
          });
        } else if (maxTurnsReached) {
          const matchedLine = findMaxTurnsReachedLine(stdoutOutput, stderrOutput);
          if (matchedLine) {
            console.log(`   Matched output: ${matchedLine}`);
          }
          settle({
            success: false,
            message: "Agent reached max turns limit",
            output,
            maxTurnsReached: true,
          });
        } else if (code === 0) {
          settle({
            success: true,
            message: "Agent completed successfully",
            output,
          });
        } else {
          settle({
            success: false,
            message: `Agent exited with code ${code}`,
            output,
            maxTurnsReached,
          });
        }
      });
    })().catch((error) => {
      settle({
        success: false,
        message: `Failed to run Agent: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
}
