/**
 * Per-tracker CLI capability flags.
 *
 * Central place declaring which optional CLI features (`--query`,
 * `--estimate`) each tracker supports, so adding a tracker or enabling a
 * capability is a one-line change instead of edits to scattered guards in
 * `src/index.ts`.
 */

export interface TrackerCapabilities {
  /** Human-readable tracker name for error/help text. */
  displayName: string;
  /** Environment variables required to use the tracker. */
  requiredEnv: string[];
  /** Supports `--query` batch selection via `searchTasks()`. */
  query: boolean;
  /** Example query shown in error/help text when relevant. */
  queryExample?: string;
  /** Supports `--estimate` (native estimation field or estimation comments). */
  estimate: boolean;
}

export const TRACKER_CAPABILITIES: Record<string, TrackerCapabilities> = {
  jira: {
    displayName: "JIRA",
    requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    query: true,
    queryExample: `project = PROJ AND status = 'To Do'`,
    estimate: true,
  },
  linear: {
    displayName: "Linear",
    requiredEnv: ["LINEAR_API_KEY"],
    query: true,
    queryExample: `{"state":{"name":{"eq":"Todo"}}}`,
    estimate: true,
  },
  github: {
    displayName: "GitHub",
    requiredEnv: ["GITHUB_TOKEN", "GITHUB_REPO"],
    query: true,
    queryExample: "is:open label:bug",
    estimate: true,
  },
  "azure-devops": {
    displayName: "Azure DevOps",
    requiredEnv: ["AZURE_DEVOPS_ORG", "AZURE_DEVOPS_PAT", "AZURE_DEVOPS_PROJECT"],
    query: true,
    queryExample: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'",
    estimate: true,
  },
  asana: {
    displayName: "Asana",
    requiredEnv: ["ASANA_API_TOKEN"],
    query: true,
    queryExample: `project:1200000000000000 section:"To Do" completed:false`,
    estimate: true,
  },
  trello: {
    displayName: "Trello",
    requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"],
    query: true,
    queryExample: `list:"To Do" is:open`,
    estimate: false,
  },
  markdown: {
    displayName: "markdown",
    requiredEnv: ["MARKDOWN_TASKS_DIR"],
    query: true,
    queryExample: "status=todo",
    estimate: false,
  },
};

/** All supported `TASK_TRACKER` values. */
export function supportedTrackers(): string[] {
  return Object.keys(TRACKER_CAPABILITIES);
}

/** Trackers that support `--query`, for help/error text. */
export function trackersSupportingQuery(): string[] {
  return Object.keys(TRACKER_CAPABILITIES).filter((t) => TRACKER_CAPABILITIES[t].query);
}

/** Trackers that support `--estimate`, for help/error text. */
export function trackersSupportingEstimate(): string[] {
  return Object.keys(TRACKER_CAPABILITIES).filter((t) => TRACKER_CAPABILITIES[t].estimate);
}

/** Whether `trackerType` supports `--query`. Unknown trackers report false. */
export function supportsQuery(trackerType: string): boolean {
  return TRACKER_CAPABILITIES[trackerType]?.query ?? false;
}

/** Whether `trackerType` supports `--estimate`. Unknown trackers report false. */
export function supportsEstimate(trackerType: string): boolean {
  return TRACKER_CAPABILITIES[trackerType]?.estimate ?? false;
}
