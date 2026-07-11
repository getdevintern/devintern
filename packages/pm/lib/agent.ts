/**
 * Agent runner wrapper for executing prompts via the configured harness.
 */

import {
  constrainedModeAllowsExternalTools,
  isModeSupported,
  runAgentBun,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentHarness,
} from "@devintern/agent-harness";

export interface RunAgentOptions extends AgentRunOptions {}

/**
 * Apply devpm's read-only policy to agent run options.
 *
 * devpm agents only draft task content on stdout; all tracker writes happen
 * in devpm itself via the backend API. Use the harness's native read-only
 * enforcement when available (never combined with permission-skip) — but
 * only when that mode keeps network and MCP tools usable, since task
 * generation may need web search or MCP access (e.g. Figma). Harnesses
 * whose constrained modes restrict external tools keep the caller's
 * unattended defaults.
 */
export function withReadonlyMode(harness: AgentHarness, options: RunAgentOptions): RunAgentOptions {
  if (!isModeSupported(harness, "readonly") || !constrainedModeAllowsExternalTools(harness)) {
    return options;
  }
  return { ...options, mode: "readonly", skipPermissions: false };
}

/**
 * Run an AI agent with the given harness and prompt.
 *
 * Always runs read-only where the harness can enforce it natively; see
 * {@link withReadonlyMode}.
 *
 * @param harness - Agent harness identifier (e.g. `claude-code`).
 * @param executablePath - Path to the agent CLI executable.
 * @param prompt - Prompt text sent to the agent.
 * @param options - Agent run options (turns, model, permissions, etc.).
 * @returns Agent run result including stdout, stderr, and exit code.
 */
export async function runAgent(
  harness: AgentHarness,
  executablePath: string,
  prompt: string,
  options: RunAgentOptions,
): Promise<AgentRunResult> {
  return runAgentBun(harness, executablePath, prompt, withReadonlyMode(harness, options));
}

/**
 * Extract a Jira story URL or construct one from an issue key in agent output.
 *
 * @param text - Raw agent output text to search.
 * @param domain - Jira Cloud domain (e.g. `your-org.atlassian.net`).
 * @returns Full browse URL if found, otherwise `null`.
 */
export function extractJiraUrl(text: string, domain: string): string | null {
  // Match patterns like:
  // https://your-org.atlassian.net/browse/PROJ-123
  // PROJ-123
  const urlPattern = new RegExp(`https://${domain.replace(".", "\\.")}/browse/([A-Z]+-\\d+)`, "i");
  const keyPattern = /\b([A-Z]+-\d+)\b/;

  const urlMatch = text.match(urlPattern);
  if (urlMatch) {
    return urlMatch[0];
  }

  const keyMatch = text.match(keyPattern);
  if (keyMatch) {
    return `https://${domain}/browse/${keyMatch[1]}`;
  }

  return null;
}

/**
 * Extract an Azure DevOps work item URL or construct one from a numeric ID.
 *
 * @param text - Raw agent output text to search.
 * @param organization - Azure DevOps organization name.
 * @param project - Azure DevOps project name.
 * @returns Full work item edit URL if found, otherwise `null`.
 */
export function extractAzureDevOpsUrl(
  text: string,
  organization: string,
  project: string,
): string | null {
  // Match patterns like:
  // https://dev.azure.com/your-org/your-project/_workitems/edit/123
  // 123 (work item ID)
  const urlPattern = new RegExp(
    `https://dev\\.azure\\.com/${organization.replace(".", "\\.")}/${project.replace(".", "\\.")}/_workitems/edit/(\\d+)`,
    "i",
  );
  const idPattern = /\b(\d{1,6})\b/;

  const urlMatch = text.match(urlPattern);
  if (urlMatch) {
    return urlMatch[0];
  }

  const idMatch = text.match(idPattern);
  if (idMatch) {
    return `https://dev.azure.com/${organization}/${project}/_workitems/edit/${idMatch[1]}`;
  }

  return null;
}

/**
 * Extract an Asana task URL or construct one from a task GID in agent output.
 *
 * @param text - Raw agent output text to search.
 * @returns Full Asana task URL if found, otherwise `null`.
 */
export function extractAsanaUrl(text: string): string | null {
  // Match patterns like:
  // https://app.asana.com/0/123456789/987654321
  // 987654321 (task GID)
  const urlPattern = /https:\/\/app\.asana\.com\/0\/\d+\/(\d+)/i;
  const gidPattern = /\b(\d{10,})\b/;

  const urlMatch = text.match(urlPattern);
  if (urlMatch) {
    return urlMatch[0];
  }

  const gidMatch = text.match(gidPattern);
  if (gidMatch) {
    return `https://app.asana.com/0/0/${gidMatch[1]}`;
  }

  return null;
}

/**
 * Extract a GitHub issue URL or construct one from an issue number reference.
 *
 * @param text - Raw agent output text to search.
 * @param owner - GitHub repository owner.
 * @param repo - GitHub repository name.
 * @returns Full issue URL if found, otherwise `null`.
 */
export function extractGitHubUrl(text: string, owner: string, repo: string): string | null {
  // Match patterns like:
  // https://github.com/owner/repo/issues/42
  // #42
  const urlPattern = new RegExp(
    `https://github\\.com/${owner.replace(".", "\\.")}/${repo.replace(".", "\\.")}/issues/(\\d+)`,
    "i",
  );
  const numberPattern = /#(\d+)/;

  const urlMatch = text.match(urlPattern);
  if (urlMatch) {
    return urlMatch[0];
  }

  const numberMatch = text.match(numberPattern);
  if (numberMatch) {
    return `https://github.com/${owner}/${repo}/issues/${numberMatch[1]}`;
  }

  return null;
}
