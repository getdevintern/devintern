/**
 * The `docs-drift-guard` preset definition.
 *
 * Configuration shape inside `[[automations]]`:
 *
 * ```toml
 * [[automations]]
 * id = "docs-drift"
 * enabled = true
 * preset = "docs-drift-guard"
 * output_mode = "ticket"          # or "pull_request"
 * cron = "0 5 * * *"
 * # doc_paths = ["guides/specific/*.md"]  # override the default documentation set
 * # baseline_sha = "abc1234"              # explicit first-run starting point
 * ```
 */

import { registerPreset } from "../preset-registry";
import type { PresetDefinition, PresetValidationContext } from "../preset-registry";
import { PRESET_VERSION } from "./constants";
import { DOCS_DRIFT_GUARD_PRESET, validateDocPathOverrides } from "./paths";
import { runDocsDriftGuard } from "./run";

export { DOCS_DRIFT_GUARD_PRESET as DOCS_DRIFT_GUARD_NAME };
export { PRESET_VERSION };

const BASELINE_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Validate the docs-drift-guard-specific option keys on a raw table. */
export function validateDocsDriftGuardOptions(context: PresetValidationContext): {
  docPaths?: string[];
  baselineSha?: string;
} {
  const docPaths = validateDocPathOverrides(context.table.doc_paths, context.error);

  let baselineSha: string | undefined;
  const rawBaseline = context.table.baseline_sha;
  if (rawBaseline !== undefined && rawBaseline !== null) {
    if (typeof rawBaseline !== "string" || !BASELINE_SHA_PATTERN.test(rawBaseline.trim())) {
      context.error("baseline_sha must be a git commit SHA (7-40 hex characters).");
    } else {
      baselineSha = rawBaseline.trim().toLowerCase();
    }
  }

  return { ...(docPaths ? { docPaths } : {}), ...(baselineSha ? { baselineSha } : {}) };
}

/** Ticket mode needs a tracker that can create issues. */
export function ticketModeRequiresIssueCreation(context: {
  trackerType: string;
  error: (message: string) => void;
}): void {
  if (!["github", "gitlab"].includes(context.trackerType)) {
    context.error(
      `output_mode "ticket" requires a tracker that can create issues (github, gitlab); ` +
        `TASK_TRACKER is "${context.trackerType}". Use output_mode = "pull_request" instead.`,
    );
  }
}

/** The docs-drift-guard definition (unregistered). */
export function docsDriftGuardDefinition(): PresetDefinition {
  return {
    name: DOCS_DRIFT_GUARD_PRESET,
    version: PRESET_VERSION,
    summary:
      "Audits newly merged default-branch commits against the documentation set and " +
      "publishes drift as deduplicated tickets or a documentation-only pull request.",
    outputModes: ["ticket", "pull_request"],
    defaultOutputMode: "ticket",
    validateOptions: (context) => {
      void validateDocsDriftGuardOptions(context);
    },
    checkPrerequisites: (context) => {
      if (context.resolved.outputMode === "ticket") {
        ticketModeRequiresIssueCreation({
          trackerType: context.trackerType,
          error: context.error,
        });
      }
    },
    run: async (input) => {
      const outcome = await runDocsDriftGuard({
        automationId: input.automationId,
        cwd: input.cwd,
        repoName: input.repoName,
        dbPath: input.dbPath,
        outputMode: input.resolved.outputMode,
        docPaths: input.resolved.options.docPaths as string[] | undefined,
        baselineSha: input.resolved.options.baselineSha as string | undefined,
        signal: input.signal,
      });
      return outcome.ok;
    },
  };
}

/** Register the preset (idempotent) and return its definition. */
export function registerDocsDriftGuard(): PresetDefinition {
  const definition = docsDriftGuardDefinition();
  registerPreset(definition);
  return definition;
}
