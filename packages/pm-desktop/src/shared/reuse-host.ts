/**
 * Which tracker host a reused secret may go to. Shared by the main process,
 * which enforces it, and the setup wizard, which shows the matching fields.
 */

import { applyPmTrackerDefaults } from "@getdevintern/pm/init-shared";

/**
 * Settings that choose the host a tracker's secret is sent to. The other
 * trackers call a fixed API host, or one set only by the main process
 * environment: `fillReusedSecrets` drops every non-step key the renderer sends,
 * so `LINEAR_API_URL` and the like never come from wizard values.
 */
const TRACKER_HOST_KEYS: Record<string, readonly string[]> = {
  jira: ["JIRA_BASE_URL"],
  gitlab: ["GITLAB_BASE_URL"],
  "azure-devops": ["AZURE_DEVOPS_ORG"],
};

function normalizeHostSetting(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Whether `values` point `trackerId` at the same host as the settings the
 * reused secret came from. Defaults apply to both sides, so a blank GitLab
 * URL matches `https://gitlab.com`.
 */
export function sameTrackerHost(
  trackerId: string,
  values: Record<string, string>,
  source: Record<string, string>,
): boolean {
  const keys = TRACKER_HOST_KEYS[trackerId] ?? [];
  if (keys.length === 0) return true;
  const requested = applyPmTrackerDefaults(trackerId, values);
  const original = applyPmTrackerDefaults(trackerId, source);
  return keys.every(
    (key) => normalizeHostSetting(requested[key]) === normalizeHostSetting(original[key]),
  );
}
