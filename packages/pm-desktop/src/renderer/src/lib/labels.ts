/**
 * Label selection helpers for the desktop composer.
 *
 * Kept pure so prune behavior can be unit-tested without mounting App.
 * Cache seeding is now handled by TanStack Query (`seedProjectStatusCaches`)
 * and cache invalidation by `invalidateLabels`.
 */

import type { LabelRef, ProjectStatus } from "../../../shared/ipc-contract.ts";

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

// Re-export the type for callers that still import it from this module.
export type { ProjectStatus };
