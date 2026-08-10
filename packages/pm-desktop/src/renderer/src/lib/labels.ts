/**
 * Label cache / selection helpers for the desktop composer.
 *
 * Kept pure so prune/cache behavior can be unit-tested without mounting App.
 */

import type { LabelListResult, LabelRef, ProjectStatus } from "../../../shared/ipc-contract.ts";

/** Drop selected label ids that are no longer present in the available set. */
export function pruneSelectedLabels(
  selected: string[],
  available: LabelRef[],
  options?: { keepUnknown?: boolean },
): string[] {
  if (selected.length === 0) return selected;
  if (options?.keepUnknown) return selected;
  const ids = new Set(available.map((label) => label.id));
  return selected.filter((id) => ids.has(id));
}

/**
 * Clear both label caches and seed them from a freshly loaded project status.
 * Shared by tracker/directory loads and project-key switches.
 */
export function applyLabelsFromProjectStatus(
  next: Pick<
    ProjectStatus,
    "supportsLabels" | "defaultProjectKey" | "labels" | "labelsTruncated" | "labelsError"
  >,
  labelsCache: Map<string, LabelListResult>,
  labelsFailedCache: Map<string, string>,
): { labels: LabelRef[]; labelsTruncated: boolean; labelsError: string | null } {
  labelsCache.clear();
  labelsFailedCache.clear();
  const labels = next.labels ?? [];
  const labelsTruncated = next.labelsTruncated ?? false;
  const labelsError = next.labelsError ?? null;
  if (next.supportsLabels) {
    const cacheKey = next.defaultProjectKey ?? "";
    if (labelsError) {
      labelsFailedCache.set(cacheKey, labelsError);
    } else {
      labelsCache.set(cacheKey, { labels, truncated: labelsTruncated });
    }
  }
  return { labels, labelsTruncated, labelsError };
}

/** Bust success + failure cache entries for a project key (Retry). */
export function clearLabelCachesForKey(
  labelsCache: Map<string, LabelListResult>,
  labelsFailedCache: Map<string, string>,
  projectKey: string,
): void {
  labelsCache.delete(projectKey);
  labelsFailedCache.delete(projectKey);
}

/**
 * Selection to keep when the available catalog cannot be loaded.
 * Clears prior-context ids so Create cannot submit stale labels — unless the
 * tracker allows freeform names (markdown), where typed labels remain valid.
 */
export function selectionAfterLabelsFailure(
  selected: string[],
  options?: { keepOnFailure?: boolean },
): string[] {
  if (options?.keepOnFailure) return selected;
  return selected.length === 0 ? selected : [];
}
