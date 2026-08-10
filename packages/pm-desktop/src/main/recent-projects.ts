/**
 * Capped recent-project list for PM Desktop.
 *
 * Extends the existing `lastProjectDir` settings key with an ordered list of
 * PM-ready folders (`.git` + `.devintern-pm`). Ineligible / missing paths are
 * omitted when the list is read so the menu stays actionable.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectGitRepository, detectPmConfig } from "./session.ts";
import { readSettings, updateSettings } from "./settings.ts";

/** Max paths kept in settings / shown in the Recent projects menu. */
export const MAX_RECENT_PROJECTS = 10;

/**
 * True when `projectDir` still exists and looks PM-ready: inside a git tree
 * and has a `.devintern-pm` config directory (same gates as a usable reopen).
 */
export function isEligibleRecentProject(projectDir: string): boolean {
  const resolved = resolve(projectDir);
  if (!existsSync(resolved)) return false;
  return detectGitRepository(resolved) && detectPmConfig(resolved);
}

/**
 * Prepend `projectDir` (resolved), drop duplicates, cap length.
 * Pure — does not check eligibility (caller decides when to record).
 */
export function rememberRecentProject(dirs: string[], projectDir: string): string[] {
  const resolved = resolve(projectDir);
  const next = [resolved];
  for (const dir of dirs) {
    const candidate = resolve(dir);
    if (candidate === resolved) continue;
    next.push(candidate);
    if (next.length >= MAX_RECENT_PROJECTS) break;
  }
  return next;
}

/** Keep first occurrence of each resolved path that is still eligible. */
export function filterEligibleRecentProjects(dirs: string[]): string[] {
  const seen = new Set<string>();
  const eligible: string[] = [];
  for (const dir of dirs) {
    const resolved = resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (!isEligibleRecentProject(resolved)) continue;
    eligible.push(resolved);
    if (eligible.length >= MAX_RECENT_PROJECTS) break;
  }
  return eligible;
}

/**
 * Coerce hand-edited / corrupt `recentProjectDirs` JSON to a string list.
 * Non-arrays become undefined so callers can fall back to `lastProjectDir`.
 */
export function normalizeRecentProjectDirs(recent: unknown): string[] | undefined {
  if (!Array.isArray(recent)) return undefined;
  return recent.filter((entry): entry is string => typeof entry === "string");
}

function seedRecentDirs(recent: string[] | undefined, last: string | undefined): string[] {
  if (recent && recent.length > 0) return recent;
  if (last) return [last];
  return [];
}

function seededRecentDirs(settings: {
  recentProjectDirs?: unknown;
  lastProjectDir?: string;
}): string[] {
  return seedRecentDirs(
    normalizeRecentProjectDirs(settings.recentProjectDirs),
    settings.lastProjectDir,
  );
}

/**
 * Return eligible recent project dirs (most recent first), seeding from
 * `lastProjectDir` when the list was never written. Read-only — filters for
 * the return value only so a concurrent {@link recordRecentProjectDir} cannot
 * be overwritten by a stale cleanup write.
 */
export async function listRecentProjectDirs(): Promise<string[]> {
  const settings = await readSettings();
  return filterEligibleRecentProjects(seededRecentDirs(settings));
}

/**
 * Record an opened project when it is PM-ready. No-ops for missing / non-git /
 * uninitialized folders so the menu never accumulates unfinished paths.
 * Also refreshes `lastProjectDir` to match the remembered path.
 *
 * Read-filter-remember-write runs inside {@link updateSettings}' serialize
 * chain so concurrent opens cannot overwrite each other's recent lists.
 */
export async function recordRecentProjectDir(projectDir: string): Promise<void> {
  if (!isEligibleRecentProject(projectDir)) return;
  const resolved = resolve(projectDir);
  await updateSettings((settings) => {
    // Filter before capping so stale/missing paths do not consume slots and
    // push out older still-eligible entries.
    const seeded = filterEligibleRecentProjects(seededRecentDirs(settings));
    const next = rememberRecentProject(seeded, resolved);
    return {
      ...settings,
      recentProjectDirs: next,
      lastProjectDir: resolved,
    };
  });
}
