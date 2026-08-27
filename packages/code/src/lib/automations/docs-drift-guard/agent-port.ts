/**
 * Agent execution port for docs-drift-guard runs.
 *
 * The default implementation spawns the configured harness headlessly — the
 * same `spawnAgent` + sandbox + usage-limit path used by the auto-review
 * loop — so preset runs inherit the CLI's agent selection, model config, and
 * OS-level sandboxing. Tests inject a fake port returning canned stdout.
 */

import {
  detectUsageLimit,
  reapTree,
  resolveExecutablePathWithRetry,
  resolveHarness,
  spawnAgent,
} from "@devintern/agent-harness";
import type { AgentHarness } from "@devintern/agent-harness";

import { buildHeadlessAgentArgs, HEADLESS_AGENT_STDIO } from "../../agent-spawn";
import { resolveAgentModel } from "../../agent-model";
import { getSandbox } from "../../sandbox";

export interface DocsDriftAgentPort {
  /**
   * Run one headless agent prompt.
   *
   * @param input.mode `analyze` prompts must not modify files; `apply` runs
   *   with write access but is constrained by prompt to documentation edits.
   * @returns Agent stdout.
   */
  run(input: { prompt: string; cwd: string; mode: "analyze" | "apply" }): Promise<string>;
}

async function runAgentPrompt(
  prompt: string,
  workingDir: string,
  harness: AgentHarness,
  executablePath: string,
): Promise<string> {
  const resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
    cwd: workingDir,
    displayName: harness.displayName,
  });

  return new Promise((resolve, reject) => {
    void (async () => {
      const timeoutMinutes = parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);
      const agentArgs = buildHeadlessAgentArgs(harness, prompt, {
        maxTurns: 300,
        skipPermissions: true,
        workingDir,
        model: resolveAgentModel(),
      });
      const { child: agentProcess, cleanup: sandboxCleanup } = await spawnAgent({
        resolvedPath,
        args: agentArgs,
        spawnOptions: { cwd: workingDir, stdio: HEADLESS_AGENT_STDIO },
        sandbox: await getSandbox(harness.name),
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeout = setTimeout(
        () => {
          timedOut = true;
          console.error(
            `⏰ [docs-drift-guard] ${harness.displayName} timed out after ${timeoutMinutes}m; killing...`,
          );
          reapTree(agentProcess, "SIGTERM");
          setTimeout(() => {
            if (!agentProcess.killed) reapTree(agentProcess, "SIGKILL");
            void sandboxCleanup();
          }, 10_000);
        },
        timeoutMinutes * 60 * 1000,
      );

      agentProcess.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      agentProcess.stderr?.on("data", (data) => {
        stderr += data.toString();
        const detected = detectUsageLimit(stdout, stderr);
        if (detected.limited) reapTree(agentProcess, "SIGTERM");
      });

      agentProcess.on("close", (code) => {
        clearTimeout(timeout);
        void sandboxCleanup();
        if (timedOut) {
          reject(new Error(`${harness.displayName} timed out after ${timeoutMinutes} minutes`));
        } else if (code !== 0) {
          reject(new Error(`${harness.displayName} exited with code ${code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
      agentProcess.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ${harness.displayName}: ${error}`));
      });
    })().catch(reject);
  });
}

/** Default agent port backed by the configured harness. */
export const defaultAgentPort: DocsDriftAgentPort = {
  async run(input) {
    const { harness, path: executablePath } = resolveHarness();
    return runAgentPrompt(input.prompt, input.cwd, harness, executablePath);
  },
};
