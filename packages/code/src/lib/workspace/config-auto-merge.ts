/** `[workspace].auto_merge*` and per-repo `auto_merge_*` parsing and resolution. */

import { AUTO_MERGE_METHODS, DEFAULT_MERGE_SAFETY_POLICY } from "../review/merge-gate";
import type { AutoMergeMethod, MergeSafetyPolicy } from "../review/merge-gate";
import { resolveRulesFilePath } from "../review/merge-safety-rules";
import { parseAgentSelection } from "../agent/selection";
import {
  readAutoMergeRules,
  readGlobList,
  readMergeSafetyPolicy,
  readOptionalBoolean,
  readReviewInstructions,
  readReviewLabel,
  readString,
} from "./config-readers";
import type { AutoMergeSettings, RepoConfig } from "./config-types";

export const DEFAULT_AUTO_MERGE_METHOD: AutoMergeMethod = "squash";

/** Parse the `[workspace].auto_merge*` keys. */
export function parseAutoMergeSettings(
  workspaceTable: Record<string, unknown>,
  errors: string[],
): AutoMergeSettings {
  const label = "[workspace]";
  const enabled = readOptionalBoolean(workspaceTable, "auto_merge", label, errors) ?? false;
  const rawMethod = readString(workspaceTable, "auto_merge_method", label, errors);
  let method = DEFAULT_AUTO_MERGE_METHOD;
  if (rawMethod) {
    if ((AUTO_MERGE_METHODS as readonly string[]).includes(rawMethod)) {
      method = rawMethod as AutoMergeMethod;
    } else {
      errors.push(`${label}.auto_merge_method must be one of: ${AUTO_MERGE_METHODS.join(", ")}.`);
    }
  }
  const agent = parseAgentSelection(workspaceTable, { label, keyPrefix: "auto_merge_" }, errors);
  const reviewInstructions = readReviewInstructions(workspaceTable, label, errors);
  return {
    enabled,
    method,
    review: readOptionalBoolean(workspaceTable, "auto_merge_review", label, errors) ?? true,
    once: readOptionalBoolean(workspaceTable, "auto_merge_once", label, errors) ?? true,
    safePaths: readGlobList(workspaceTable, "auto_merge_safe_paths", label, errors),
    denyPaths: readGlobList(workspaceTable, "auto_merge_deny_paths", label, errors),
    reviewPaths: readGlobList(workspaceTable, "auto_merge_review_paths", label, errors),
    reviewLabel: readReviewLabel(workspaceTable, label, errors),
    policy: readMergeSafetyPolicy(workspaceTable, label, errors) ?? DEFAULT_MERGE_SAFETY_POLICY,
    reviewLargeDiffs:
      readOptionalBoolean(workspaceTable, "auto_merge_review_large_diffs", label, errors) ?? false,
    ...(reviewInstructions ? { reviewInstructions } : {}),
    ...readAutoMergeRules(workspaceTable, label, errors),
    ...(Object.keys(agent).length > 0 ? { agent } : {}),
  };
}

/** `{ [key]: value }`, or `{}` when the value is unset. */
function optionalEntry<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Per-repo `auto_merge_policy`, `_review_instructions`, and `_rules` / `_rules_file`. */
export function repoAutoMergeReview(
  table: Record<string, unknown>,
  label: string,
  errors: string[],
): Pick<
  RepoConfig,
  "autoMergePolicy" | "autoMergeReviewInstructions" | "autoMergeRules" | "autoMergeRulesFile"
> {
  const { rules, rulesFile } = readAutoMergeRules(table, label, errors);
  return {
    ...optionalEntry("autoMergePolicy", readMergeSafetyPolicy(table, label, errors)),
    ...optionalEntry("autoMergeReviewInstructions", readReviewInstructions(table, label, errors)),
    ...optionalEntry("autoMergeRules", rules),
    ...optionalEntry("autoMergeRulesFile", rulesFile),
  };
}

/** The `custom` rules source a repo uses: its own when it sets one, else the workspace's. */
function rulesSourceFor(
  settings: AutoMergeSettings,
  repo: Pick<RepoConfig, "autoMergeRules" | "autoMergeRulesFile">,
): { rules?: string; rulesFile?: string } {
  if (repo.autoMergeRules !== undefined || repo.autoMergeRulesFile !== undefined) {
    return {
      ...optionalEntry("rules", repo.autoMergeRules),
      ...optionalEntry("rulesFile", repo.autoMergeRulesFile),
    };
  }
  return {
    ...optionalEntry("rules", settings.rules),
    ...optionalEntry("rulesFile", settings.rulesFile),
  };
}

/**
 * Check the `custom` policy wiring: `custom` needs exactly one rules source,
 * and a rules source is only allowed where the policy in effect is `custom`.
 * (Setting both keys at one level is reported by the reader.)
 */
export function validateAutoMergeRules(
  settings: AutoMergeSettings,
  repos: readonly RepoConfig[],
  errors: string[],
): void {
  const check = (
    label: string,
    policy: MergeSafetyPolicy,
    ownSource: boolean,
    effectiveSource: boolean,
  ): void => {
    if (ownSource && policy !== "custom") {
      errors.push(
        `${label}.auto_merge_rules and auto_merge_rules_file apply only with ` +
          `auto_merge_policy = "custom" (the policy here is "${policy}").`,
      );
    } else if (policy === "custom" && !effectiveSource) {
      errors.push(
        `${label}.auto_merge_policy = "custom" needs auto_merge_rules or auto_merge_rules_file.`,
      );
    }
  };
  const workspaceSource = settings.rules !== undefined || settings.rulesFile !== undefined;
  check("[workspace]", settings.policy, workspaceSource, workspaceSource);
  for (const repo of repos) {
    const ownSource = repo.autoMergeRules !== undefined || repo.autoMergeRulesFile !== undefined;
    const policy = repo.autoMergePolicy ?? settings.policy;
    // A repo inheriting the workspace's custom policy was checked above.
    if (!ownSource && repo.autoMergePolicy === undefined) continue;
    check(`[[repos]] "${repo.name}"`, policy, ownSource, ownSource || workspaceSource);
  }
}

/**
 * Effective merge-safety review settings for one repository (repo values
 * replace workspace ones). A `custom` policy's rules file is resolved
 * against the workspace home, never the repository checkout.
 */
export function autoMergeReviewFor(
  settings: AutoMergeSettings,
  repo: Pick<
    RepoConfig,
    "autoMergePolicy" | "autoMergeReviewInstructions" | "autoMergeRules" | "autoMergeRulesFile"
  >,
  workspaceDir: string,
): {
  reviewPolicy: MergeSafetyPolicy;
  reviewInstructions?: string;
  rules?: string;
  rulesFile?: string;
} {
  const instructions = repo.autoMergeReviewInstructions ?? settings.reviewInstructions;
  const reviewPolicy = repo.autoMergePolicy ?? settings.policy;
  const source = reviewPolicy === "custom" ? rulesSourceFor(settings, repo) : {};
  return {
    reviewPolicy,
    ...(instructions ? { reviewInstructions: instructions } : {}),
    ...(source.rulesFile
      ? { rulesFile: resolveRulesFilePath(source.rulesFile, workspaceDir) }
      : source.rules
        ? { rules: source.rules }
        : {}),
  };
}

/** Effective auto-merge path policy for one repository (repo lists replace workspace lists). */
export function autoMergePathsFor(
  settings: AutoMergeSettings,
  repo: Pick<RepoConfig, "autoMergeSafePaths" | "autoMergeDenyPaths" | "autoMergeReviewPaths">,
): { safePaths: string[]; denyPaths: string[]; reviewPaths: string[] } {
  return {
    safePaths: repo.autoMergeSafePaths ?? settings.safePaths,
    denyPaths: repo.autoMergeDenyPaths ?? settings.denyPaths,
    reviewPaths: repo.autoMergeReviewPaths ?? settings.reviewPaths,
  };
}
