/**
 * Tracker labels setup relies on: the `devintern` label behind the default
 * ready-tasks query (interactive "Create the devintern label?" or
 * `--create-label`), and the labels a custom query names (`label:<x>`),
 * checked after the dry run so a misspelled label is caught. Never created
 * silently.
 */

import { GitHubClient, GitLabClient, sanitizeGitlabBaseUrl } from "@devintern/task-trackers";

import { DEVINTERN_LABEL, supportsLabelCreation } from "../trackers/capabilities";

/**
 * Lookup and creation of a label in one tracker. `name` defaults to
 * {@link DEVINTERN_LABEL}.
 */
export interface DevinternLabelOps {
  exists(name?: string): Promise<boolean>;
  create(name?: string): Promise<void>;
  /** Where the labels live, for messages: `owner/repo` or the GitLab project path. */
  location?: string;
}

/** Builds the label operations for a tracker, or undefined when it cannot create labels. */
export type DevinternLabelOpsFactory = (
  tracker: string,
  env: Record<string, string | undefined>,
) => DevinternLabelOps | undefined;

const LABEL_COLOR = "5319e7";
const DEVINTERN_LABEL_DESCRIPTION =
  "Ready for DevIntern: the worker picks up open tickets with this label";

function labelOptions(name: string): { color: string; description?: string } {
  return name === DEVINTERN_LABEL
    ? { color: LABEL_COLOR, description: DEVINTERN_LABEL_DESCRIPTION }
    : { color: LABEL_COLOR };
}

/**
 * Label operations against the tracker API, built from `env` (the same
 * credentials the worker polls with). Undefined for trackers without label
 * creation or with incomplete credentials.
 */
export const defaultDevinternLabelOps: DevinternLabelOpsFactory = (tracker, env) => {
  if (!supportsLabelCreation(tracker)) return undefined;
  if (tracker === "github") {
    const [owner, repo] = (env.GITHUB_REPO ?? "").split("/");
    if (!env.GITHUB_TOKEN || !owner || !repo) return undefined;
    const client = new GitHubClient({ token: env.GITHUB_TOKEN, owner, repo });
    return {
      location: `${owner}/${repo}`,
      exists: (name = DEVINTERN_LABEL) => client.hasLabel(name),
      create: (name = DEVINTERN_LABEL) => client.createLabel(name, labelOptions(name)),
    };
  }
  if (tracker === "gitlab") {
    if (!env.GITLAB_TOKEN || !env.GITLAB_PROJECT) return undefined;
    const client = new GitLabClient({
      token: env.GITLAB_TOKEN,
      projectPath: env.GITLAB_PROJECT,
      baseUrl: sanitizeGitlabBaseUrl(env.GITLAB_BASE_URL),
    });
    return {
      location: env.GITLAB_PROJECT,
      exists: (name = DEVINTERN_LABEL) => client.hasLabel(name),
      create: (name = DEVINTERN_LABEL) => client.createLabel(name, labelOptions(name)),
    };
  }
  return undefined;
};
