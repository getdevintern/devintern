/**
 * run-tests — run a deterministic command (Bun test or typecheck) after the
 * implementation is committed and halt delivery when it exits non-zero.
 *
 * Copy this file to `.devintern-code/steps/run-tests.ts` in your repository and
 * register it from `.devintern-code/settings.json` (see settings.json here).
 */

import { isAbsolute, join } from "node:path";

import type { PipelineContext, StepDefinition, TaskStepResult } from "@getdevintern/code/pipeline";

interface RunTestsOptions {
  /** Executable to run. Defaults to `bun`. */
  command?: string;
  /** Argument array. Defaults to `["test"]`. Never a shell string. */
  args?: string[];
  /** Working directory relative to `context.workingDir` (or absolute). */
  cwd?: string;
  /** Cap on captured stdout+stderr bytes. Defaults to 4000. */
  maxDiagnosticsBytes?: number;
  /** `halt` (default) blocks publication; `warn` is advisory. */
  onFail?: "halt" | "warn";
}

const DEFAULT_ARGS = ["test"];
const DEFAULT_MAX_DIAGNOSTICS = 4_000;
const TRUNCATION_NOTICE = "\n…[diagnostics truncated]";

/** Read a child stream, keeping at most `cap` characters. */
async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (output.length >= cap) {
        truncated = true;
        continue;
      }
      output += decoder.decode(value, { stream: true });
      if (output.length > cap) {
        output = output.slice(0, cap);
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return truncated ? output + TRUNCATION_NOTICE : output;
}

function resolvedCwd(context: PipelineContext, cwd: string | undefined): string {
  if (!cwd) return context.workingDir;
  return isAbsolute(cwd) ? cwd : join(context.workingDir, cwd);
}

const definition: StepDefinition = {
  name: "run-tests",
  create(config) {
    const options = config as RunTestsOptions;
    const command = typeof options.command === "string" ? options.command : "bun";
    const args =
      Array.isArray(options.args) && options.args.every((arg) => typeof arg === "string")
        ? [...options.args]
        : DEFAULT_ARGS;
    const maxDiagnosticsBytes =
      typeof options.maxDiagnosticsBytes === "number" &&
      Number.isSafeInteger(options.maxDiagnosticsBytes) &&
      options.maxDiagnosticsBytes > 0
        ? options.maxDiagnosticsBytes
        : DEFAULT_MAX_DIAGNOSTICS;
    const onFail = options.onFail === "warn" ? "warn" : "halt";

    return {
      name: "run-tests",
      async run(context: PipelineContext): Promise<TaskStepResult> {
        const cwd = resolvedCwd(context, options.cwd);
        const proc = Bun.spawn([command, ...args], {
          cwd,
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          readBounded(proc.stdout, maxDiagnosticsBytes),
          readBounded(proc.stderr, maxDiagnosticsBytes),
          proc.exited,
        ]);

        const summary = `\`${command} ${args.join(" ")}\` exited ${exitCode} in ${cwd}`;
        console.log(`🧪 run-tests: ${summary}`);
        if (exitCode === 0) {
          return { kind: "continue", data: { command, args, cwd, exitCode } };
        }

        const diagnostics = [stdout, stderr]
          .filter((part) => part.trim())
          .join("\n")
          .trim();
        const reason = [
          `Verification command \`${command} ${args.join(" ")}\` failed with exit code ${exitCode}.`,
          `Fix the failure in ${cwd} and re-run the task.`,
          diagnostics ? `\n--- output ---\n${diagnostics}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return onFail === "warn" ? { kind: "warn", reason } : { kind: "halt", reason };
      },
    };
  },
};

export default definition;
