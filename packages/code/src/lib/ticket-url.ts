/**
 * Tracker ticket URL derivation.
 *
 * The run recorder stores a `ticket_url` per run so the dashboard can link
 * straight to the tracker ticket. Most tracker clients do not return the
 * issue's web URL in their payloads, so URLs are derived from base
 * configuration (environment) plus the task key. Trackers whose web links
 * need information not present in configuration (e.g. Linear requires the
 * organization slug) yield no URL and the dashboard falls back to plain text.
 */

/** Strip trailing slashes so a base like `https://acme.atlassian.net/` joins cleanly. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isNumericKey(taskKey: string): boolean {
  return /^\d+$/.test(taskKey);
}

function buildJiraUrl(taskKey: string, baseUrl?: string): string | undefined {
  if (!baseUrl || !/^[A-Z][A-Z0-9]*-\d+$/.test(taskKey)) {
    return undefined;
  }
  return `${trimTrailingSlash(baseUrl)}/browse/${taskKey}`;
}

function buildGitHubUrl(taskKey: string, repo?: string): string | undefined {
  if (!repo || !isNumericKey(taskKey) || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return undefined;
  }
  return `https://github.com/${repo}/issues/${taskKey}`;
}

function buildGitLabUrl(
  taskKey: string,
  projectPath?: string,
  baseUrl?: string,
): string | undefined {
  if (!projectPath || !isNumericKey(taskKey)) {
    return undefined;
  }
  const base = trimTrailingSlash(baseUrl ?? "https://gitlab.com");
  return `${base}/${projectPath}/-/issues/${taskKey}`;
}

function buildAzureDevOpsUrl(taskKey: string, org?: string, project?: string): string | undefined {
  if (!org || !project || !isNumericKey(taskKey)) {
    return undefined;
  }
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${taskKey}`;
}

function buildAsanaUrl(taskKey: string): string | undefined {
  if (!isNumericKey(taskKey)) {
    return undefined;
  }
  // The /0/0/<gid> form is the canonical shareable link regardless of project.
  return `https://app.asana.com/0/0/${taskKey}`;
}

function buildTrelloUrl(taskKey: string): string | undefined {
  // Task keys are card shortLinks or full ids — short alphanumeric slugs.
  if (!/^[a-z0-9]{8,}$/i.test(taskKey)) {
    return undefined;
  }
  return `https://trello.com/c/${taskKey}`;
}

/**
 * Derive a ticket's web URL for the given tracker type from base config +
 * task key. Returns `undefined` when the tracker has no derivable URL
 * (missing config, synthetic keys, or unsupported trackers like linear and
 * markdown files).
 *
 * @param tracker - Tracker type (`TASK_TRACKER` value)
 * @param taskKey - Task key assigned by that tracker
 * @param env - Environment source; defaults to `process.env` (tests inject one)
 */
export function buildTicketUrl(
  tracker: string | null | undefined,
  taskKey: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  switch (tracker) {
    case "jira":
      return buildJiraUrl(taskKey ?? "", env.JIRA_BASE_URL);
    case "github":
      return buildGitHubUrl(taskKey ?? "", env.GITHUB_REPO);
    case "gitlab":
      return buildGitLabUrl(taskKey ?? "", env.GITLAB_PROJECT, env.GITLAB_BASE_URL);
    case "azure-devops":
      return buildAzureDevOpsUrl(taskKey ?? "", env.AZURE_DEVOPS_ORG, env.AZURE_DEVOPS_PROJECT);
    case "asana":
      return buildAsanaUrl(taskKey ?? "");
    case "trello":
      return buildTrelloUrl(taskKey ?? "");
    default:
      return undefined;
  }
}
