/**
 * The `devintern` label behind the default ready-tasks query: whether the
 * tracker already has it, and creating it when the user asked (interactive
 * "Create the devintern label?" or `--create-label`). Never created silently.
 */

import { GitHubClient, GitLabClient, sanitizeGitlabBaseUrl } from "@devintern/task-trackers";

import { DEVINTERN_LABEL, supportsLabelCreation } from "../trackers/capabilities";

/** Lookup and creation of the {@link DEVINTERN_LABEL} label in one tracker. */
export interface DevinternLabelOps {
  exists(): Promise<boolean>;
  create(): Promise<void>;
}

/** Builds the label operations for a tracker, or undefined when it cannot create labels. */
export type DevinternLabelOpsFactory = (
  tracker: string,
  env: Record<string, string | undefined>,
) => DevinternLabelOps | undefined;

const LABEL_OPTIONS = {
  color: "5319e7",
  description: "Ready for DevIntern: the worker picks up open tickets with this label",
};

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
      exists: () => client.hasLabel(DEVINTERN_LABEL),
      create: () => client.createLabel(DEVINTERN_LABEL, LABEL_OPTIONS),
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
      exists: () => client.hasLabel(DEVINTERN_LABEL),
      create: () => client.createLabel(DEVINTERN_LABEL, LABEL_OPTIONS),
    };
  }
  return undefined;
};
