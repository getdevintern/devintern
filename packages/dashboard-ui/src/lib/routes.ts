/** Hash routes of the dashboard SPA. */
export type Route =
  | { view: "overview" }
  | { view: "runs" }
  | { view: "run"; id: number }
  | { view: "automations" }
  | { view: "automation"; id: string }
  | { view: "prs" }
  | { view: "stats" }
  | { view: "logs" }
  | { view: "workspace" };

/** Hash of the runs list (the landing `#/` is the overview). */
export const RUNS_HASH = "#/runs";

/** Hash of one run's detail page. */
export function runHash(id: number): string {
  return `#/runs/${id}`;
}

/** Retired hashes and where they now live, so old bookmarks keep working. */
const LEGACY_HASHES: Record<string, string> = {
  // Task activity was folded into the overview's "Active work" section.
  "#/activity": "#/",
};

/** The hash a retired route redirects to, or null when the hash is current. */
export function redirectHash(hash: string): string | null {
  return LEGACY_HASHES[hash] ?? null;
}

/**
 * Parse a location hash into a route. `#/` (and anything unrecognized) is the
 * overview; the runs list lives at `#/runs`.
 */
export function parseHash(hash: string): Route {
  const runMatch = hash.match(/^#\/runs\/(\d+)$/);
  if (runMatch) {
    return { view: "run", id: parseInt(runMatch[1] ?? "0", 10) };
  }
  if (hash === "#/runs") return { view: "runs" };
  const automationMatch = hash.match(/^#\/automations\/(.+)$/);
  if (automationMatch) {
    try {
      return { view: "automation", id: decodeURIComponent(automationMatch[1] ?? "") };
    } catch {
      return { view: "automations" };
    }
  }
  if (hash === "#/automations") return { view: "automations" };
  if (hash === "#/stats") return { view: "stats" };
  if (hash === "#/prs") return { view: "prs" };
  if (hash === "#/logs") return { view: "logs" };
  if (hash === "#/workspace") return { view: "workspace" };
  return { view: "overview" };
}
