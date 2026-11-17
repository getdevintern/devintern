import type { RunRecord } from "@/lib/api";

/** A run plus any earlier attempts at the same work, newest first. */
export interface RunGroup {
  key: string;
  latest: RunRecord;
  /** Earlier attempts on this page, newest first (empty for a single run). */
  earlier: RunRecord[];
}

/** Runs record the repo as either `owner/name` or bare `name`; compare by name. */
function repoName(repo: string | undefined): string {
  return repo?.split("/").pop()?.toLowerCase() ?? "";
}

/**
 * Identity of the work a run attempts. Retries reuse the task key (scheduled
 * runs: their per-occurrence key), so origin + task key + repo names one
 * piece of work; PR-driven runs without a task key use the PR. Runs with
 * neither stand alone.
 */
export function runGroupKey(run: RunRecord): string {
  const repo = repoName(run.repo);
  if (run.taskKey) return `${run.origin}|${repo}|task:${run.taskKey}`;
  if (run.prNumber !== undefined) return `${run.origin}|${repo}|pr:${run.prNumber}`;
  return `run:${run.id}`;
}

/**
 * Collapse attempts at the same work into one group, placed where its newest
 * attempt sits. Input is the API's newest-first page; grouping only spans
 * that page.
 */
export function groupRunAttempts(runs: RunRecord[]): RunGroup[] {
  const groups: RunGroup[] = [];
  const byKey = new Map<string, RunGroup>();
  for (const run of runs) {
    const key = runGroupKey(run);
    const existing = byKey.get(key);
    if (existing) {
      existing.earlier.push(run);
      continue;
    }
    const group: RunGroup = { key, latest: run, earlier: [] };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}
