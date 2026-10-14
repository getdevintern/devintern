/**
 * check-policy — block a change that adds files under explicitly forbidden
 * paths. It inspects the runtime-provided diff against the PR target
 * (`context.getDiff()`), so it works with any code host and never shells out.
 *
 * Copy this file to `.devintern-code/steps/check-policy.ts` and register it in
 * `.devintern-code/settings.json` (see settings.json here).
 */

import type { PipelineContext, StepDefinition, TaskStepResult } from "@getdevintern/code/pipeline";

interface CheckPolicyOptions {
  /** Path prefixes that new files must not be added under, e.g. `["secrets/"]`. */
  forbiddenPaths?: string[];
  /** `halt` (default) blocks publication; `warn` records a finding only. */
  onFail?: "halt" | "warn";
}

interface PolicyFinding {
  path: string;
  rule: string;
}

const DEFAULT_FORBIDDEN = ["secrets/", "credentials/"];

/** Extract paths newly added by a unified diff against the PR target. */
export function addedFilesFromDiff(diff: string): string[] {
  const added = new Set<string>();
  let candidate = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      candidate = false;
    } else if (line.startsWith("new file mode")) {
      candidate = true;
    } else if (line.startsWith("--- ")) {
      candidate = line.slice(4).trim() === "/dev/null";
    } else if (line.startsWith("+++ ")) {
      if (candidate) {
        const path = normalizePath(line.slice(4).trim().replace(/^b\//, ""));
        if (path && path !== "/dev/null") added.add(path);
      }
      candidate = false;
    }
  }
  return [...added];
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

function matchesRule(path: string, rule: string): boolean {
  const normalized = normalizePath(rule);
  if (!normalized) return false;
  const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
  return path === normalized || path.startsWith(prefix) || path.includes(`/${prefix}`);
}

const definition: StepDefinition = {
  name: "check-policy",
  create(config) {
    const options = config as CheckPolicyOptions;
    const forbidden =
      Array.isArray(options.forbiddenPaths) &&
      options.forbiddenPaths.every((entry) => typeof entry === "string")
        ? options.forbiddenPaths
        : DEFAULT_FORBIDDEN;
    const onFail = options.onFail === "warn" ? "warn" : "halt";

    return {
      name: "check-policy",
      async run(context: PipelineContext): Promise<TaskStepResult> {
        const added = addedFilesFromDiff(context.getDiff());
        const findings: PolicyFinding[] = [];
        for (const path of added) {
          for (const rule of forbidden) {
            if (matchesRule(path, rule)) {
              findings.push({ path, rule });
              break;
            }
          }
        }

        console.log(
          `🔒 check-policy: inspected ${added.length} added file(s), ${findings.length} violation(s)`,
        );
        if (findings.length === 0) {
          return { kind: "continue", data: { addedFiles: added, findings } };
        }

        const details = findings
          .map((finding) => `  - ${finding.path} (matches "${finding.rule}")`)
          .join("\n");
        const reason = [
          `Policy violation: ${findings.length} newly added file(s) fall under a forbidden path.`,
          details,
          "Move the file out of the forbidden path or get an explicit exception before publishing.",
        ].join("\n");
        return onFail === "warn"
          ? { kind: "warn", reason, data: { addedFiles: added, findings } }
          : { kind: "halt", reason, data: { addedFiles: added, findings } };
      },
    };
  },
};

export default definition;
