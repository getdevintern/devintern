/**
 * Labels a ready-tasks query names (`label:<x>`) that the repository lacks.
 * A query with a misspelled label passes the dry run with 0 tasks and the
 * worker then waits forever, so after the dry run `worker init` looks each
 * named label up (GitHub, GitLab): the wizard asks to fix the query, create
 * the labels, or continue; flags mode reports a warning and a `fix-query`
 * next step. No API call when the query has no label term.
 */

import {
  MAX_PROMPT_ATTEMPTS,
  condenseMessage,
  createPromptAttempts,
} from "@devintern/task-trackers";

import { TRACKER_CAPABILITIES, supportsLabelCreation } from "../trackers/capabilities";
import { extractQueryLabels } from "../trackers/query-labels";
import { errorMessage } from "./worker-init-fs";
import type { DevinternLabelOps, DevinternLabelOpsFactory } from "./worker-init-label";
import type { InitCheck } from "./worker-init-noninteractive-types";
import type { LogFn, PromptFn } from "./worker-init-policy";
import { withTimeout } from "./worker-init-run";

/** Report check name (flags mode) for labels the query names but the tracker lacks. */
export const QUERY_LABELS_CHECK = "query-labels";

/**
 * GitLab label filters that are not label names: `None` (no label) and
 * `Any` (at least one label).
 */
const GITLAB_LABEL_KEYWORDS = new Set(["none", "any"]);

/**
 * The labels a query names that are worth checking against the tracker:
 * every `label:` term for trackers that can look labels up (GitHub, GitLab),
 * minus `skip` (case-insensitive) and GitLab's `None`/`Any` keywords.
 * Empty for other trackers and for queries without a label term.
 */
export function queryLabelsToCheck(
  tracker: string,
  query: string,
  skip: readonly string[] = [],
): string[] {
  if (!supportsLabelCreation(tracker)) return [];
  const skipped = new Set(skip.map((name) => name.toLowerCase()));
  return extractQueryLabels(query).filter((name) => {
    const key = name.toLowerCase();
    if (skipped.has(key)) return false;
    return !(tracker === "gitlab" && GITLAB_LABEL_KEYWORDS.has(key));
  });
}

/** Of `labels`, the ones the tracker does not have (looked up in parallel; a failed lookup throws). */
async function missingLabels(ops: DevinternLabelOps, labels: readonly string[]): Promise<string[]> {
  const found = await Promise.all(labels.map((name) => ops.exists(name)));
  return labels.filter((_, index) => !found[index]);
}

/** `Label "x" does not exist` / `Labels "x", "y" do not exist`. */
function missingLabelsPhrase(labels: readonly string[]): string {
  const names = labels.map((name) => `"${name}"`).join(", ");
  return labels.length === 1 ? `Label ${names} does not exist` : `Labels ${names} do not exist`;
}

/** What the wizard step needs: the tracker, its prompts, and the label API. */
interface ReviewContext {
  trackerType: string;
  trackerName: string;
  log: LogFn;
  prompt: PromptFn;
  deps: { devinternLabelOps?: DevinternLabelOpsFactory };
}

/**
 * Wizard, after the dry run: when the repository lacks a label the query
 * names, ask "fix the query, create the label, or continue? [f/c/k]"
 * (Enter fixes). `skip` names labels already handled (the default query's
 * devintern label). A failed lookup or creation only warns.
 *
 * @returns `fix` to prompt for the query again, `keep` to accept it
 */
export async function reviewQueryLabels(
  run: ReviewContext,
  query: string,
  env: Record<string, string | undefined>,
  skip: readonly string[] = [],
): Promise<"fix" | "keep"> {
  const { trackerType, trackerName } = run;
  const labels = queryLabelsToCheck(trackerType, query, skip);
  if (labels.length === 0) return "keep";
  const ops = run.deps.devinternLabelOps?.(trackerType, env);
  if (!ops) return "keep";
  let missing: string[];
  try {
    missing = await missingLabels(ops, labels);
  } catch (error) {
    run.log(`⚠️  Could not check the query's labels: ${errorMessage(error)}`);
    return "keep";
  }
  if (missing.length === 0) return "keep";
  const where = ops.location ?? trackerName;
  const labelWord = missing.length === 1 ? "label" : "labels";
  const reject = createPromptAttempts("query labels");
  for (;;) {
    const answer = (
      await run.prompt(
        `⚠️  ${missingLabelsPhrase(missing)} in ${where}. Fix the query, create the ${labelWord}, or continue? [f/c/k]: `,
      )
    )
      .trim()
      .toLowerCase();
    if (!answer || answer === "f" || answer === "fix") return "fix";
    if (answer === "k" || answer === "continue" || answer === "keep") {
      run.log(`   Keeping the query. It matches nothing until the ${labelWord} exist in ${where}.`);
      return "keep";
    }
    if (answer === "c" || answer === "create") break;
    run.log("   Enter f (fix the query), c (create), or k (continue).");
    reject(`No valid label choice after ${MAX_PROMPT_ATTEMPTS} attempts; enter f, c, or k`);
  }
  for (const name of missing) {
    try {
      await ops.create(name);
      run.log(`🏷️  Created the label "${name}" in ${where}.`);
    } catch (error) {
      run.log(`⚠️  Could not create the label "${name}": ${errorMessage(error)}`);
      run.log(`   Create it in ${where} (the token may lack permission to manage labels).`);
    }
  }
  return "keep";
}

/**
 * Flags mode, after the dry run passed: the report row for labels
 * `--task-query` names that the repository lacks. Warns and never fails (a
 * label can be created later); the report's next steps then include
 * `fix-query`.
 *
 * @returns The report row, or undefined when there is nothing to check
 */
export async function queryLabelsCheck(
  plan: { tracker: string; taskQuery: string; credentialEnv: Record<string, string | undefined> },
  options: { labelOps: DevinternLabelOpsFactory; timeoutMs: number; skip?: readonly string[] },
): Promise<InitCheck | undefined> {
  const labels = queryLabelsToCheck(plan.tracker, plan.taskQuery, options.skip);
  if (labels.length === 0) return undefined;
  const ops = options.labelOps(plan.tracker, plan.credentialEnv);
  if (!ops) return undefined;
  const name = TRACKER_CAPABILITIES[plan.tracker]?.displayName ?? plan.tracker;
  const where = ops.location ?? name;
  const base = { name: QUERY_LABELS_CHECK, label: "Query labels" } as const;
  let missing: string[];
  try {
    missing = await withTimeout(
      missingLabels(ops, labels),
      options.timeoutMs,
      `${name} label lookup`,
    );
  } catch (error) {
    return {
      ...base,
      status: "skipped",
      message: `could not look up the query's labels in ${where}: ${condenseMessage(errorMessage(error))}`,
    };
  }
  if (missing.length === 0) {
    return { ...base, status: "pass", message: `Every label the query names exists in ${where}` };
  }
  const labelWord = missing.length === 1 ? "label" : "labels";
  return {
    ...base,
    status: "warn",
    message: `${missingLabelsPhrase(missing)} in ${where}, so the query matches nothing until ${missing.length === 1 ? "it exists" : "they exist"}`,
    hint: `Fix the label name in --task-query, or create the ${labelWord} in ${where}`,
  };
}
