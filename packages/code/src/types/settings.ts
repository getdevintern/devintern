// Settings types for .devintern-code/settings.json

/**
 * Common project configuration fields shared across all task trackers.
 *
 * Different platforms use these concepts differently:
 * - **Jira**: status transitions (e.g., "In Progress", "In Review")
 * - **Linear**: workflow states (e.g., "In Progress", "In Review")
 * - **Trello**: list names (e.g., "Doing", "Code Review")
 * - **Azure DevOps**: work item states (e.g., "Active", "Resolved")
 * - **Asana**: sections / custom fields (e.g., "In Progress", "Backlog")
 * - **GitHub Issues**: labels / issue states (e.g., "in progress", "in review")
 * - **Markdown**: conceptual statuses for local workflow tracking
 */
export interface BaseProjectConfig {
  /**
   * Status / state / label to transition to after PR creation
   * e.g., "In Review" (Jira), "In Review" (Linear), "Code Review" (Trello),
   *       "Resolved" (Azure DevOps), "in review" (GitHub)
   */
  prStatus?: string;
  /**
   * Status / state / label to transition to when starting task implementation
   * e.g., "In Progress" (Jira), "In Progress" (Linear), "Doing" (Trello),
   *       "Active" (Azure DevOps), "in progress" (GitHub)
   */
  inProgressStatus?: string;
  /**
   * Status / state / label to transition to when implementation fails or is incomplete
   * e.g., "To Do" (Jira), "Backlog" (Linear), "To Do" (Trello),
   *       "New" (Azure DevOps), "todo" (GitHub)
   */
  todoStatus?: string;
  /**
   * Custom field ID or name for story points / estimation
   * If not set, auto-discovery will search for tracker-specific fields
   * e.g., "customfield_10016" (Jira), "estimate" (Linear), "Story Points" (Trello)
   */
  storyPointsField?: string;
}

/** JIRA-specific project configuration (currently uses the common base). */
export type JiraProjectConfig = BaseProjectConfig;

/** Linear-specific project configuration (currently uses the common base). */
export type LinearProjectConfig = BaseProjectConfig;

/** Trello-specific project configuration (currently uses the common base). */
export type TrelloProjectConfig = BaseProjectConfig;

/** Azure DevOps-specific project configuration (currently uses the common base). */
export type AzureDevOpsProjectConfig = BaseProjectConfig;

/** Asana-specific project configuration (currently uses the common base). */
export type AsanaProjectConfig = BaseProjectConfig;

/** GitHub Issues-specific project configuration (currently uses the common base). */
export type GitHubProjectConfig = BaseProjectConfig;

/** Markdown-specific project configuration (currently uses the common base). */
export type MarkdownProjectConfig = BaseProjectConfig;

/**
 * A tracker-specific section containing per-project configurations.
 */
export interface TrackerSection<T = BaseProjectConfig> {
  projects?: {
    [projectKey: string]: T;
  };
}

/**
 * Per-project configuration settings.
 *
 * Supports tracker-specific sections so teams using Linear, Trello,
 * Azure DevOps, Asana, or GitHub Issues can prepare settings before
 * full client support lands.
 *
 * Backward compatibility: the legacy top-level `projects` map is still
 * honored for JIRA when no `jira` section exists.
 */
export interface ProjectSettings {
  /**
   * Legacy project configurations (backward compatible).
   *
   * Originally JIRA-only. When `TASK_TRACKER=jira` (or unset), these
   * entries are used as a fallback if no `jira` section exists.
   */
  projects?: {
    [projectKey: string]: BaseProjectConfig;
  };

  /** JIRA-specific project configurations */
  jira?: TrackerSection<JiraProjectConfig>;
  /** Linear-specific project configurations */
  linear?: TrackerSection<LinearProjectConfig>;
  /** Trello-specific project configurations */
  trello?: TrackerSection<TrelloProjectConfig>;
  /** Azure DevOps-specific project configurations */
  "azure-devops"?: TrackerSection<AzureDevOpsProjectConfig>;
  /** Asana-specific project configurations */
  asana?: TrackerSection<AsanaProjectConfig>;
  /** GitHub Issues-specific project configurations */
  github?: TrackerSection<GitHubProjectConfig>;
  /** Markdown-specific project configurations */
  markdown?: TrackerSection<MarkdownProjectConfig>;
}
