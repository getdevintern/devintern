/** Fallback issue types when a supporting backend cannot provide a list. */
export const DEFAULT_ISSUE_TYPES = ["Task", "Story", "Bug", "Epic"];

/**
 * Choose the most appropriate default issue type from a list of available types.
 *
 * Prefers a regular Task, falls back to Story, then to the first non-Epic type,
 * and finally to the first available type so we never error.
 *
 * @param types - Available issue type names from the tracker.
 * @returns The best default type name.
 */
export function getDefaultIssueType(types: string[]): string {
  if (types.length === 0) {
    return "Task";
  }

  const normalized = types.map((t) => t.toLowerCase());

  const taskIndex = normalized.indexOf("task");
  if (taskIndex >= 0) {
    return types[taskIndex]!;
  }

  const storyIndex = normalized.indexOf("story");
  if (storyIndex >= 0) {
    return types[storyIndex]!;
  }

  const nonEpicIndex = normalized.findIndex((t) => t !== "epic");
  if (nonEpicIndex >= 0) {
    return types[nonEpicIndex]!;
  }

  return types[0]!;
}

/**
 * Order issue types for display so the preferred default appears first.
 * Preserves relative order of the remaining types.
 */
export function orderIssueTypes(types: string[]): string[] {
  if (types.length === 0) {
    return types;
  }
  const preferred = getDefaultIssueType(types);
  return [preferred, ...types.filter((t) => t !== preferred)];
}
