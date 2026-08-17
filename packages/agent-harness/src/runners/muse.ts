/**
 * Muse Code headless runner with JSONL streaming and prompt-file delivery.
 */

import type { ChildProcess, SpawnOptions } from "child_process";
import { preparePromptWithAttachments } from "../attachments.js";
import { isMuseHarness } from "../harnesses/muse.js";
import { assertMuseBinaryAvailable, probeMuseCliVersion } from "../harnesses/muse/binary.js";
import { MUSE_SHUTDOWN_GRACE_MS } from "../harnesses/muse/constants.js";
import { describeMuseExitState, mapMuseExitState } from "../harnesses/muse/exit-codes.js";
import {
  createMuseJsonlParseState,
  feedMuseJsonlChunk,
  flushMuseJsonlBuffer,
  museNormalizedText,
} from "../harnesses/muse/jsonl.js";
import { cleanupMusePromptFile, planMusePromptDelivery } from "../harnesses/muse/prompt-file.js";
import { MuseConfigError } from "../harnesses/muse/validation.js";
import type { MuseRunResult } from "../harnesses/muse/types.js";
import { UnsupportedAgentModeError } from "../modes.js";
import { reapTree, spawnReapable } from "../process-reaper.js";
import { resolveExecutablePathWithRetry } from "../resolver.js";
import type { AgentHarness, AgentRunOptions } from "../types.js";

export interface MuseRunnerOptions extends AgentRunOptions {
  cwd?: string;
  timeoutMinutes?: number;
  displayRealtime?: boolean;
}

function isVerbose(options: MuseRunnerOptions): boolean {
  return options.verbose === true || process.env.DEVINTERN_VERBOSE === "1";
}

function logMuse(message: string, options: MuseRunnerOptions): void {
  if (isVerbose(options)) {
    process.stderr.write(`[muse] ${message}\n`);
  }
}

/**
 * Run Muse Code via `muse exec --json` with incremental JSONL parsing.
 *
 * @param harness - Muse harness instance.
 * @param executablePath - Path to the `muse` binary.
 * @param prompt - Task prompt.
 * @param options - Run and Muse-specific options.
 */
export async function runAgentMuse(
  harness: AgentHarness,
  executablePath: string,
  prompt: string,
  options: MuseRunnerOptions = {},
): Promise<MuseRunResult> {
  if (!isMuseHarness(harness)) {
    throw new Error("runAgentMuse requires the Muse harness");
  }

  const spawnCwd = options.cwd ?? options.workingDir;

  let resolvedPath: string;
  try {
    resolvedPath = await resolveExecutablePathWithRetry(executablePath, {
      cwd: spawnCwd,
      displayName: harness.displayName,
    });
    resolvedPath = assertMuseBinaryAvailable(resolvedPath, spawnCwd);
  } catch (error) {
    if (error instanceof Error) {
      return {
        stdout: "",
        stderr: error.message,
        exitCode: 1,
        maxTurnsReached: false,
        exitState: "binary_missing",
        normalizedText: "",
        rawStdout: "",
        events: [],
        parseErrors: [],
        warnings: [],
      };
    }
    throw error;
  }

  let cliVersion: string | undefined;
  try {
    cliVersion = probeMuseCliVersion(resolvedPath);
  } catch {
    cliVersion = undefined;
  }

  const warnings = harness.collectWarnings(options);
  for (const warning of warnings) {
    console.warn(`⚠️  ${warning}`);
  }

  if (cliVersion) {
    logMuse(`CLI version: ${cliVersion}`, options);
  }

  const { prompt: effectivePrompt } = preparePromptWithAttachments(harness, prompt, options);

  let baseArgs: string[];
  try {
    baseArgs = harness.buildArgs(options);
  } catch (error) {
    if (error instanceof MuseConfigError || error instanceof UnsupportedAgentModeError) {
      return {
        stdout: "",
        stderr: error.message,
        exitCode: 1,
        maxTurnsReached: false,
        exitState: "invalid_config",
        normalizedText: "",
        rawStdout: "",
        events: [],
        parseErrors: [],
        warnings,
        cliVersion,
      };
    }
    throw error;
  }

  const delivery = planMusePromptDelivery(effectivePrompt);
  const args = [...baseArgs, ...delivery.args];

  const timeoutMinutes =
    options.timeoutMinutes ?? parseInt(process.env.AGENT_HARNESS_TIMEOUT_MINUTES || "60", 10);

  if (!options.silent) {
    console.log(`\n🤖 Running ${harness.displayName} (headless JSONL)...\n`);
  }

  logMuse(
    `Spawning: ${resolvedPath} ${args
      .map((arg) => (arg === effectivePrompt ? `<prompt:${effectivePrompt.length} chars>` : arg))
      .join(" ")}`,
    options,
  );

  return new Promise((resolve) => {
    let tempPromptFile = delivery.tempPromptFile;
    let timedOut = false;
    let cancelled = false;
    let rawStdout = "";
    let stderr = "";
    let settled = false;
    let lastStreamedTextLength = 0;

    const parseState = createMuseJsonlParseState();
    const lineBuffer = { partial: "" };

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupMusePromptFile(tempPromptFile);
      tempPromptFile = undefined;

      flushMuseJsonlBuffer(parseState, lineBuffer, (event) => {
        logMuse(`event: ${event.type ?? "unknown"}`, options);
      });

      const normalizedText = museNormalizedText(parseState);
      let code = exitCode ?? 1;
      const exitState = mapMuseExitState(code, {
        timedOut,
        cancelled,
        stepLimitReached: parseState.stepLimitReached,
        stderr,
      });

      if ((parseState.stepLimitReached || exitState === "step_limit") && code === 0) {
        code = 1;
      }

      if (exitState !== "completed") {
        logMuse(describeMuseExitState(exitState), options);
      }

      if (parseState.parseErrors.length > 0) {
        for (const parseError of parseState.parseErrors) {
          console.warn(`⚠️  Muse JSONL parse warning: ${parseError}`);
        }
      }

      resolve({
        stdout: normalizedText,
        stderr,
        exitCode: code,
        maxTurnsReached: parseState.stepLimitReached || exitState === "step_limit",
        exitState,
        normalizedText,
        rawStdout,
        events: parseState.events,
        parseErrors: parseState.parseErrors,
        warnings,
        cliVersion,
      });
    };

    const spawnOptions: SpawnOptions = {
      cwd: spawnCwd,
      stdio: ["ignore", "pipe", "pipe"],
    };

    let proc: ChildProcess;
    try {
      proc = spawnReapable(resolvedPath, args, spawnOptions);
    } catch (error) {
      cleanupMusePromptFile(tempPromptFile);
      const message = error instanceof Error ? error.message : String(error);
      settled = true;
      resolve({
        stdout: "",
        stderr: message,
        exitCode: 1,
        maxTurnsReached: false,
        exitState: "binary_missing",
        normalizedText: "",
        rawStdout: "",
        events: [],
        parseErrors: [],
        warnings,
        cliVersion,
      });
      return;
    }

    const timeout = setTimeout(
      () => {
        timedOut = true;
        cancelled = true;
        console.error(
          `\n⏰ ${harness.displayName} timed out after ${timeoutMinutes} minutes, sending SIGTERM...`,
        );
        reapTree(proc, "SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            reapTree(proc, "SIGKILL");
          }
        }, MUSE_SHUTDOWN_GRACE_MS);
      },
      timeoutMinutes * 60 * 1000,
    );

    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      rawStdout += chunk;
      feedMuseJsonlChunk(parseState, lineBuffer, chunk, (event) => {
        logMuse(`event: ${event.type ?? "unknown"}`, options);
      });

      const normalizedText = museNormalizedText(parseState);
      if (normalizedText.length > lastStreamedTextLength) {
        const delta = normalizedText.slice(lastStreamedTextLength);
        lastStreamedTextLength = normalizedText.length;
        if (options.displayRealtime) {
          process.stdout.write(delta);
        }
        options.onStdout?.(delta);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      if (options.displayRealtime) {
        process.stderr.write(chunk);
      }
      options.onStderr?.(chunk);
    });

    proc.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      cleanupMusePromptFile(tempPromptFile);
      const exitState = error.code === "ENOENT" ? "binary_missing" : "failed";
      resolve({
        stdout: museNormalizedText(parseState),
        stderr: `${stderr}${error.message}`.trim(),
        exitCode: 1,
        maxTurnsReached: parseState.stepLimitReached,
        exitState,
        normalizedText: museNormalizedText(parseState),
        rawStdout,
        events: parseState.events,
        parseErrors: parseState.parseErrors,
        warnings,
        cliVersion,
      });
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (timedOut) {
        finish(143);
        return;
      }
      finish(code);
    });
  });
}
