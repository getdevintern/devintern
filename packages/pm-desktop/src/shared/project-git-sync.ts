/**
 * Project checkout sync status (fetch + optional ff-only pull).
 * Shared by main, preload, and renderer.
 */

export type ProjectGitSyncKind =
  | "ok"
  | "no_remote"
  | "skipped_dirty"
  | "behind"
  | "diverged"
  | "error";

export interface ProjectGitSyncStatus {
  kind: ProjectGitSyncKind;
  /**
   * True when the only local dirtiness is a dirty repo-root `.gitignore`
   * (pm init). Silent in the project bar; still used for pull gating and
   * overwrite messaging.
   */
  softDirty: boolean;
  /** Current local branch name (or short SHA when detached). */
  branch?: string;
  /** Commits behind upstream after fetch (when known). */
  behind?: number;
  /** Commits ahead of upstream after fetch (when known). */
  ahead?: number;
  /** True when this run fast-forwarded the branch. */
  updated?: boolean;
  /**
   * True when this run completed a successful `git fetch`.
   * Pre-fetch skips (e.g. open-path hard-dirty) leave this unset so callers
   * do not advance `lastFetch`.
   */
  fetched?: boolean;
  /** Short user-facing explanation. */
  message: string;
}

/** Whether the thin Update control should be shown (enabled or disabled with reason). */
export function shouldShowUpdateFromRemote(sync: ProjectGitSyncStatus | undefined): boolean {
  if (!sync) return false;
  // Hide only when there is nothing to sync against. Errors stay visible so
  // users can retry without reopening the project (message is on the control).
  return sync.kind !== "no_remote";
}

/** Whether the thin Update control should be enabled for this sync snapshot. */
export function canUpdateProjectFromRemote(sync: ProjectGitSyncStatus | undefined): boolean {
  if (!sync) return false;
  if (sync.kind === "no_remote") return false;
  // Soft-dirty must not block Update. Hard-dirty open path may land in
  // skipped_dirty without behind counts — keep Update enabled so a later
  // click re-classifies (fetchHardDirty default true) after the user
  // commits/stashes, same retry path as error/diverged.
  return (
    sync.kind === "behind" ||
    sync.kind === "ok" ||
    sync.kind === "diverged" ||
    sync.kind === "error" ||
    sync.kind === "skipped_dirty"
  );
}

/** Compact label for the project bar. */
export function projectGitSyncLabel(sync: ProjectGitSyncStatus): string | null {
  switch (sync.kind) {
    case "ok":
      if (sync.updated) return "Got updates";
      // Soft-dirty (pm init `.gitignore` append) is expected — do not surface it.
      return null;
    case "no_remote":
      return "Not linked online";
    case "skipped_dirty":
      return sync.behind && sync.behind > 0
        ? `${sync.behind} update${sync.behind === 1 ? "" : "s"} · local edits`
        : "Local edits";
    case "behind":
      return sync.behind && sync.behind > 0
        ? `${sync.behind} update${sync.behind === 1 ? "" : "s"}`
        : "Updates available";
    case "diverged":
      return "Can't get updates";
    case "error":
      return "Couldn't get updates";
    default:
      return null;
  }
}
