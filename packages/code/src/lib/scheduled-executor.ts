import {
  detectIncompleteImplementation,
  detectMaxTurnsReached,
  detectOpenQuestions,
  detectUsageLimit,
  reapTree,
  resolveExecutablePathStrict,
  resolveHarness,
  spawnAgent,
} from "@devintern/agent-harness";
import type { AgentHarness, AgentRunOptions, AgentRunResult } from "@devintern/agent-harness";
import { createEngine, getDefaultIssueType } from "@getdevintern/pm/engine";
import { loadConfig } from "@getdevintern/pm/config";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { buildHeadlessAgentArgs, HEADLESS_AGENT_STDIO } from "./agent-spawn";
import type { AutomationAction } from "./automation-config";
import { endRun, beginRun, recordRunStage, recordRunTicket } from "./run-recorder";
import { getSandbox } from "./sandbox";

export const MAX_AGENT_OUTPUT_CHARS = 64_000;

/** Retain only the diagnostic tail needed by scheduled-run output detectors. */
export function appendOutputTail(current: string, chunk: string): string {
  if (chunk.length >= MAX_AGENT_OUTPUT_CHARS) return chunk.slice(-MAX_AGENT_OUTPUT_CHARS);
  return `${current.slice(chunk.length - MAX_AGENT_OUTPUT_CHARS)}${chunk}`;
}

export interface ScheduledExecution {
  automationId: string;
  action: AutomationAction;
  prompt: string;
  trackerProject?: string;
  repo?: string;
  cwd?: string;
}

/** PM prompt assets live in the sibling package in source and in code/dist after bundling. */
export function scheduledPmPromptsDir(moduleUrl = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  return moduleDir.endsWith("/dist") || moduleDir.endsWith("\\dist")
    ? join(moduleDir, "prompts")
    : join(moduleDir, "..", "..", "..", "pm", "prompts");
}

/** Run an agent through code's normal harness resolution and sandbox wrapper. */
async function runHeadlessAgent(
  harness: AgentHarness,
  executablePath: string,
  prompt: string,
  options: AgentRunOptions,
  cwd: string,
): Promise<AgentRunResult> {
  const args = buildHeadlessAgentArgs(harness, prompt, { ...options, workingDir: cwd });
  const sandbox = await getSandbox(harness.name);
  const { child, cleanup } = await spawnAgent({
    resolvedPath: executablePath,
    args,
    sandbox,
    spawnOptions: { cwd, env: process.env, stdio: HEADLESS_AGENT_STDIO },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    stdout = appendOutputTail(stdout, text);
    process.stdout.write(text);
    options.onStdout?.(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr = appendOutputTail(stderr, text);
    process.stderr.write(text);
    options.onStderr?.(text);
  });

  const terminate = () => reapTree(child);
  const nodeProcess = process as NodeJS.Process;
  nodeProcess.once("SIGTERM", terminate);
  nodeProcess.once("SIGINT", terminate);
  try {
    const exitCode = await new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    return {
      stdout,
      stderr,
      exitCode,
      maxTurnsReached: detectMaxTurnsReached(stdout, stderr, harness.supportsMaxTurns ?? false),
    };
  } finally {
    const removeSignalListener = nodeProcess.removeListener.bind(nodeProcess) as (
      event: string,
      listener: () => void,
    ) => NodeJS.Process;
    removeSignalListener("SIGTERM", terminate);
    removeSignalListener("SIGINT", terminate);
    await cleanup();
  }
}

/** Execute one already-claimed automation inside its dedicated subprocess. */
export async function executeScheduledAutomation(input: ScheduledExecution): Promise<boolean> {
  const cwd = input.cwd ?? process.cwd();
  beginRun({
    origin: "scheduled",
    automationId: input.automationId,
    tracker: process.env.TASK_TRACKER,
    harness: process.env.AGENT_HARNESS ?? "claude-code",
    repo: input.repo,
  });

  try {
    if (input.action === "headless") {
      const resolved = resolveHarness();
      resolved.path = resolveExecutablePathStrict(resolved.path, resolved.harness.displayName);
      const result = await runHeadlessAgent(
        resolved.harness,
        resolved.path,
        input.prompt,
        {
          maxTurns: 500,
          skipPermissions: true,
        },
        cwd,
      );
      const combined = `${result.stdout}\n${result.stderr}`;
      const usage = detectUsageLimit(result.stdout, result.stderr);
      const questions = detectOpenQuestions(result.stdout);
      const incomplete = detectIncompleteImplementation(result.stdout);
      if (usage.limited) {
        recordRunStage("implementation", {
          status: "deferred",
          summary: usage.matchedLine ?? "Usage limit reached",
        });
        endRun(
          "deferred",
          usage.resetsAt ? `Usage limit; resets ${usage.resetsAt}` : "Usage limit",
        );
        return false;
      }
      if (questions.awaitingInput || incomplete.incomplete || result.maxTurnsReached) {
        const reason = questions.awaitingInput
          ? `Awaiting input: ${questions.questions.join("; ")}`
          : result.maxTurnsReached
            ? "Agent reached its maximum turn limit"
            : incomplete.reasons.join("; ");
        recordRunStage("implementation", {
          status: "escalated",
          summary: reason,
          detail: { output: combined.slice(-4000) },
        });
        endRun("escalated", reason);
        return false;
      }
      if (result.exitCode !== 0) {
        const reason = `Agent exited with code ${result.exitCode}`;
        recordRunStage("implementation", {
          status: "failed",
          summary: reason,
          detail: { output: combined.slice(-4000) },
        });
        endRun("failed", reason);
        return false;
      }
      recordRunStage("implementation", {
        status: "succeeded",
        summary: "Scheduled prompt completed",
      });
      endRun("succeeded");
      return true;
    }

    const config = await loadConfig({ baseDir: cwd });
    const engine = await createEngine(
      config,
      { baseDir: cwd, promptsDir: scheduledPmPromptsDir() },
      {
        runAgent: (harness, executablePath, prompt, options) =>
          runHeadlessAgent(harness, executablePath, prompt, options, cwd),
      },
    );
    const project = input.trackerProject ?? engine.defaultProjectKey;
    const draft = await engine.generateStory({
      source: { type: "prompt", content: input.prompt },
      promptStyle: "technical",
    });
    const issueType = getDefaultIssueType(await engine.listIssueTypes(project));
    const created = await engine.createTask(draft, { issueType, projectKey: project });
    recordRunTicket({ key: created.task.key, url: created.task.url });
    console.log(
      `✅ [automation:${input.automationId}] created ${created.task.key}: ${created.task.url}`,
    );

    const partialErrors = [
      created.epicLinkError,
      created.labelsApplyError,
      ...(created.attachmentErrors ?? []),
    ].filter((error): error is string => Boolean(error));
    if (partialErrors.length > 0) {
      const reason = `Ticket created, but follow-up metadata failed: ${partialErrors.join("; ")}`;
      recordRunStage("implementation", { status: "failed", summary: reason });
      endRun("failed", reason);
      return false;
    }
    recordRunStage("implementation", {
      status: "succeeded",
      summary: `Created ticket ${created.task.key}`,
    });
    endRun("succeeded");
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordRunStage("implementation", { status: "failed", summary: reason });
    endRun("failed", reason);
    console.error(`❌ [automation:${input.automationId}] ${reason}`);
    return false;
  }
}
