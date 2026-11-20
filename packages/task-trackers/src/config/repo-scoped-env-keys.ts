/**
 * Env keys that select one repository/board/project.
 *
 * They belong to the project, not to a shared workspace credential file, so
 * neither runtime loading nor `init` reuse may copy them across projects
 * (repo B would file tasks into repo A's board).
 */
export const REPO_SCOPED_ENV_KEYS: ReadonlySet<string> = new Set([
  "JIRA_DEFAULT_PROJECT_KEY",
  "LINEAR_DEFAULT_TEAM_KEY",
  "GITHUB_REPO",
  // Legacy owner fallback for a bare GITHUB_REPO; together they name the destination.
  "GITHUB_OWNER",
  "GITLAB_PROJECT",
  "AZURE_DEVOPS_PROJECT",
  "TRELLO_DEFAULT_BOARD_ID",
  "TRELLO_DEFAULT_LIST_NAME",
  "ASANA_DEFAULT_PROJECT_GID",
  "MARKDOWN_TASKS_DIR",
]);
