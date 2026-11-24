/**
 * Hand a stacked task's base to the pipeline through its description.
 *
 * The pipeline already resolves the feature-branch base, the PR target, and
 * the auto-review diff base from a `Target branch:` line in the description
 * (`extractTargetBranch` → `resolveEffectiveTargetBranch`). A stacked task
 * gets a generated section carrying that line plus a machine-readable marker,
 * so all three stay consistent and the PR body builder can say which PR this
 * one is stacked on.
 */

import { extractTargetBranch } from "../utils/general";
import type { StackBase } from "./gate";

const MARKER = /<!--\s*devintern:stacked-on\s+([^>]*?)\s*-->/i;

/** Render the generated "Stacked on" section appended to a stacked task's description. */
export function renderStackedOnSection(base: StackBase): string {
  const attributes = [
    `task=${base.taskKey}`,
    `pr=${base.prNumber}`,
    `branch=${base.branch}`,
    ...(base.prUrl ? [`url=${base.prUrl}`] : []),
  ].join(" ");
  const pr = base.prUrl ? `[PR #${base.prNumber}](${base.prUrl})` : `PR #${base.prNumber}`;
  return [
    `<!-- devintern:stacked-on ${attributes} -->`,
    "## Stacked on",
    "",
    `This task builds on ${base.taskKey} (${pr}, branch \`${base.branch}\`), which is not merged yet.`,
    "Start from that branch and keep its changes; this PR targets it.",
    "",
    `Target branch: ${base.branch}`,
  ].join("\n");
}

/** Parse the stacked-on marker written by {@link renderStackedOnSection}. */
export function parseStackedOnMarker(description: string | undefined): StackBase | null {
  const match = description?.match(MARKER);
  if (!match?.[1]) return null;
  const fields = new Map<string, string>();
  for (const pair of match[1].split(/\s+/)) {
    const index = pair.indexOf("=");
    if (index > 0) fields.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const taskKey = fields.get("task");
  const branch = fields.get("branch");
  const prNumber = Number(fields.get("pr"));
  if (!taskKey || !branch || !Number.isInteger(prNumber) || prNumber <= 0) return null;
  return { taskKey, branch, prNumber, prUrl: fields.get("url") };
}

/**
 * The description the pipeline should see for a dependency-gated task.
 *
 * Stacked onto an unmerged dependency, the body gains the generated section,
 * unless the body already names a target branch: an explicit `Target branch:`
 * wins, and `warn` is told why the stacked base was dropped.
 *
 * @returns The body to materialize and the base actually applied
 */
export function applyStackBase(
  body: string,
  stackedOn: StackBase | undefined,
  warn: (message: string) => void = () => {},
): { body: string; stackedOn?: StackBase } {
  if (!stackedOn) return { body };
  const explicit = extractTargetBranch(body);
  if (explicit) {
    warn(
      `explicit "Target branch: ${explicit}" in the description wins over the stacked base ` +
        `${stackedOn.branch} (${stackedOn.taskKey} PR #${stackedOn.prNumber})`,
    );
    return { body };
  }
  return { body: `${body.trimEnd()}\n\n${renderStackedOnSection(stackedOn)}\n`, stackedOn };
}

/**
 * Env var carrying a tracker ticket's stack base into its task subprocess.
 * Tracker tickets have no local description file to append the section to,
 * so the worker passes the marker here and the pipeline applies it with
 * {@link applyStackBase} to the description it read from the tracker.
 */
export const STACKED_ON_ENV = "DEVINTERN_STACKED_ON";

/** Encode a stack base for {@link STACKED_ON_ENV}. */
export function encodeStackBaseEnv(base: StackBase): string {
  return renderStackedOnSection(base).split("\n")[0] ?? "";
}

/** Decode {@link STACKED_ON_ENV}; `undefined` when unset or malformed. */
export function stackBaseFromEnv(
  env: Record<string, string | undefined> = process.env,
): StackBase | undefined {
  return parseStackedOnMarker(env[STACKED_ON_ENV]) ?? undefined;
}

/**
 * The stack base a tracker ticket's run should apply, from
 * {@link STACKED_ON_ENV}. An explicit `Target branch:` in the description wins
 * (as in {@link applyStackBase}); the env var is then removed so the PR body
 * does not claim a stack the run did not use.
 */
export function takeStackBaseFromEnv(
  description: string | undefined,
  warn: (message: string) => void = () => {},
  env: Record<string, string | undefined> = process.env,
): StackBase | undefined {
  const base = stackBaseFromEnv(env);
  if (!base) return undefined;
  const applied = applyStackBase(description ?? "", base, warn);
  if (!applied.stackedOn) {
    delete env[STACKED_ON_ENV];
    return undefined;
  }
  return applied.stackedOn;
}
