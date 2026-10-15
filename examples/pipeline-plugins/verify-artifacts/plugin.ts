/**
 * verify-artifacts — check that a generated artifact exists and carries the
 * fields a downstream consumer requires. This is a deterministic check (no
 * agent), so it is cheap and safe to run after `commit` and before `finalize`.
 *
 * The parsed artifact is returned as structured `data`, so a later step can
 * read it through `context.results` without re-reading the file.
 *
 * Copy this file to `.devintern-code/steps/verify-artifacts.ts` and register it
 * in `.devintern-code/settings.json` (see settings.json here).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { PipelineContext, StepDefinition, TaskStepResult } from "@getdevintern/code/pipeline";

interface VerifyArtifactsOptions {
  /** Artifact path relative to `context.workingDir` (or absolute). */
  path: string;
  /** Fields that must be present and non-empty on the parsed artifact. */
  requiredFields?: string[];
  /** `halt` (default) blocks publication; `warn` records a finding only. */
  onFail?: "halt" | "warn";
}

function resolvePath(context: PipelineContext, path: string): string {
  return isAbsolute(path) ? path : join(context.workingDir, path);
}

const definition: StepDefinition = {
  name: "verify-artifacts",
  create(config) {
    const options = config as unknown as VerifyArtifactsOptions;
    if (typeof options.path !== "string" || !options.path.trim()) {
      throw new Error("verify-artifacts requires a non-empty 'path' option");
    }
    const requiredFields =
      Array.isArray(options.requiredFields) &&
      options.requiredFields.every((field) => typeof field === "string")
        ? options.requiredFields
        : [];
    const onFail = options.onFail === "warn" ? "warn" : "halt";
    const artifactPath = options.path;

    return {
      name: "verify-artifacts",
      async run(context: PipelineContext): Promise<TaskStepResult> {
        const file = resolvePath(context, artifactPath);
        const fail = (reason: string): TaskStepResult =>
          onFail === "warn" ? { kind: "warn", reason } : { kind: "halt", reason };

        if (!existsSync(file)) {
          return fail(
            `Expected artifact is missing: ${file}. Run the generator/build before this step.`,
          );
        }

        await context.artifacts.addFile({
          key: "verified-artifact",
          path: file,
          title: "Generated artifact under verification",
          kind: "verification",
          mediaType: "application/json",
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
          return fail(`Artifact ${file} is not valid JSON: ${(error as Error).message}`);
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return fail(`Artifact ${file} must be a JSON object`);
        }

        const record = parsed as Record<string, unknown>;
        const missing = requiredFields.filter((field) => {
          const value = record[field];
          return value === undefined || value === null || value === "";
        });
        if (missing.length > 0) {
          return fail(`Artifact ${file} is missing required field(s): ${missing.join(", ")}.`);
        }

        console.log(`📦 verify-artifacts: ${file} is valid`);
        return { kind: "continue", data: { path: file, artifact: parsed } };
      },
    };
  },
};

export default definition;
