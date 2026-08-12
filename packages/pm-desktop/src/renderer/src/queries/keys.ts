/**
 * TanStack Query keys for the pm-desktop renderer.
 *
 * Keys encode the full identity of the data. Tracker-scoped queries (issue
 * types, labels) are namespaced under `["tracker"]` and scoped by project
 * dir + project key, so switching project dirs uses different cache entries
 * structurally (no cross-dir contamination even if invalidation is missed).
 * The `["tracker"]` prefix also enables a single
 * `invalidateQueries({ queryKey: ["tracker"] })` to bust all tracker-sourced
 * data on tracker switch.
 *
 * Global queries (not scoped by any project context) keep flat keys.
 */

export const qk = {
  appVersion: ["appVersion"] as const,
  codeDiscoveryDismissed: ["codeDiscoveryDismissed"] as const,
  recentProjects: ["recentProjects"] as const,
  projectStatus: (dir: string) => ["projectStatus", dir] as const,
  issueTypes: (dir: string, projectKey: string) =>
    ["tracker", "issueTypes", dir, projectKey] as const,
  labels: (dir: string, projectKey: string) => ["tracker", "labels", dir, projectKey] as const,
  githubAuthStatus: ["githubAuthStatus"] as const,
  githubOAuthAvailable: ["githubOAuthAvailable"] as const,
  githubRepos: ["githubRepos"] as const,
  analyticsEnabled: ["analyticsEnabled"] as const,
  updateStatus: ["updateStatus"] as const,
  projectInit: (dir: string) => ["projectInit", dir] as const,
} as const;

/** Prefix used to bust all tracker-sourced data (issue types + labels). */
export const TRACKER_KEY_PREFIX = ["tracker"] as const;
