/**
 * Desktop helpers for issue-type lists — thin wrappers over the shared CLI logic
 * in `@getdevintern/pm/issue-types` so composer defaults stay in parity.
 *
 * Cache seeding is now handled by TanStack Query (`seedProjectStatusCaches`).
 */

import {
  DEFAULT_ISSUE_TYPES,
  getDefaultIssueType,
  orderIssueTypes,
} from "@getdevintern/pm/issue-types";

export { DEFAULT_ISSUE_TYPES, getDefaultIssueType, orderIssueTypes };

/** Resolve tracker types or the shared Task-first fallback. */
export function resolveIssueTypes(types: string[] | undefined | null): string[] {
  return types && types.length > 0 ? types : [...DEFAULT_ISSUE_TYPES];
}

/**
 * When the current selection is missing from the available list (or unset),
 * return the CLI default for that list; otherwise `null` (keep selection).
 */
export function issueTypeIfNeedsReset(current: string | undefined, types: string[]): string | null {
  if (current && types.includes(current)) {
    return null;
  }
  return getDefaultIssueType(types);
}
