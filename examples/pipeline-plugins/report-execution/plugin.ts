/**
 * report-execution — submit a redacted DevIntern bug report when a pipeline
 * run records warnings, or on every run when `on: "always"` is configured.
 *
 * This step is deliberately non-fatal: reporting is observability, not
 * delivery. If the report cannot be prepared or sent, the step returns a
 * warning and the run continues.
 *
 * Halt and exception reporting is handled by the CLI itself, because a halt
 * stops later steps before this one runs. Use this step to attach custom
 * evidence (step results, warnings, an artifact file) on runs that complete.
 *
 * Copy this file to `.devintern-code/steps/report-execution.ts` and register it
 * in `.devintern-code/settings.json` (see settings.json here). Keep `dryRun`
 * enabled until you have reviewed the prepared payload.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { createBugReporter, readStoredIdentity } from "@getdevintern/code/report";
import type { ReportEvidence } from "@getdevintern/code/report";
import type {
  PipelineContext,
  StepDefinition,
  TaskStepResult as PipelineStepResult,
} from "@getdevintern/code/pipeline";

interface ReportExecutionOptions {
  /** Report when warnings were recorded (default), or on every run. */
  on?: "warn" | "always";
  /** Prepare and log without sending. Defaults to true for safety. */
  dryRun?: boolean;
  /** Attach the worker's captured log tail. Default false. */
  includeLogs?: boolean;
  /** Optional evidence file, relative to `context.workingDir`. */
  evidenceFile?: string;
  /** Contact email for anonymous reports. */
  email?: string;
  /** Endpoint override for self-hosted report intake. */
  endpoint?: string;
  /** Access token override; defaults to the stored CLI session. */
  accessToken?: string;
  /** Injectable transport for tests and custom deployments. */
  fetchImpl?: typeof fetch;
}

const MAX_EVIDENCE_FILE_BYTES = 16 * 1024;

function resolvePath(context: PipelineContext, path: string): string {
  return isAbsolute(path) ? path : join(context.workingDir, path);
}

function summarizeResults(context: PipelineContext): string[] {
  return context.results.map((record) => {
    const result = record.result;
    switch (result.kind) {
      case "halt":
        return `${record.step}: halt — ${result.reason}`;
      case "warn":
        return `${record.step}: warn — ${result.reason}`;
      case "repeat":
        return `${record.step}: repeat from ${result.from}${result.reason ? ` — ${result.reason}` : ""}`;
      default:
        return `${record.step}: ${result.kind}`;
    }
  });
}

function hasWarnings(context: PipelineContext): boolean {
  return (
    context.warnings.length > 0 || context.results.some((record) => record.result.kind === "warn")
  );
}

function readEvidenceFile(context: PipelineContext, path: string): ReportEvidence | undefined {
  const resolved = resolvePath(context, path);
  if (!existsSync(resolved)) return undefined;
  try {
    const text = readFileSync(resolved, "utf8").slice(0, MAX_EVIDENCE_FILE_BYTES);
    return {
      key: "evidence-file",
      title: "Attached evidence",
      mediaType: resolved.endsWith(".json") ? "application/json" : "text/plain",
      text,
    };
  } catch {
    return undefined;
  }
}

const definition: StepDefinition = {
  name: "report-execution",
  create(config) {
    const options = config as ReportExecutionOptions;
    if (options.on !== undefined && options.on !== "warn" && options.on !== "always") {
      throw new Error("report-execution 'on' must be 'warn' or 'always'");
    }
    const on = options.on ?? "warn";
    const dryRun = options.dryRun !== false;

    return {
      name: "report-execution",
      async run(context: PipelineContext): Promise<PipelineStepResult> {
        if (on === "warn" && !hasWarnings(context)) {
          return { kind: "continue" };
        }

        const evidence: ReportEvidence[] = [
          {
            key: "steps",
            title: "Pipeline step results",
            mediaType: "text/plain",
            text: summarizeResults(context).join("\n"),
          },
          ...(context.warnings.length > 0
            ? [
                {
                  key: "warnings",
                  title: "Recorded warnings",
                  mediaType: "text/plain",
                  text: context.warnings.join("\n"),
                },
              ]
            : []),
        ];
        if (options.evidenceFile) {
          const fileEvidence = readEvidenceFile(context, options.evidenceFile);
          if (fileEvidence) evidence.push(fileEvidence);
        }

        const identity = readStoredIdentity();
        const accessToken = options.accessToken ?? identity.accessToken;
        const reporter = createBugReporter({
          ...(options.endpoint ? { endpoint: options.endpoint } : {}),
          ...(accessToken ? { accessToken } : {}),
          signedIn: Boolean(options.accessToken) || identity.signedIn,
          ...(options.email ? { contactEmail: options.email } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });

        try {
          const prepared = await reporter.prepare({
            title: on === "always" ? "Pipeline run report" : "Pipeline warnings in a task run",
            description: [
              `Automated pipeline report for ${context.taskKey ?? "a task run"}.`,
              `Steps: ${context.results.map((record) => record.step).join(" → ")}`,
              context.warnings.length > 0 ? `Warnings: ${context.warnings.length}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            source: "pipeline",
            taskKey: context.taskKey,
            diagnostics: true,
            logs: options.includeLogs === true,
            evidence,
          });

          if (dryRun) {
            console.log(
              `🐞 report-execution: prepared ${prepared.bytes} bytes ` +
                `(${prepared.payload.context?.logs?.length ?? 0} log attachment(s)); dry run, not sent`,
            );
            return {
              kind: "continue",
              data: {
                report: prepared.payload,
              } satisfies Record<string, unknown>,
            };
          }

          const result = await reporter.submitPrepared(prepared);
          console.log(`🐞 report-execution: sent report ${result.id}`);
          return {
            kind: "continue",
            data: {
              report: {
                id: result.id,
                ...(result.url ? { url: result.url } : {}),
              },
            } satisfies Record<string, unknown>,
          };
        } catch (error) {
          const reason = `report-execution could not file a report: ${(error as Error).message}`;
          console.warn(`⚠️  ${reason}`);
          return { kind: "warn", reason };
        }
      },
    };
  },
};

export default definition;
