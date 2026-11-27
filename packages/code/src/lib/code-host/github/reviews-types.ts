/** Pull request, CI, and review-comment shapes returned by `GitHubReviewsClient`. */

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  /** Whether a closed PR was merged. */
  merged?: boolean;
  merged_at?: string | null;
  head: {
    ref: string;
    sha: string;
    /** Head repository; differs from the base repo for fork PRs. */
    repo?: { full_name: string } | null;
  };
  base: {
    ref: string;
    sha: string;
  };
  html_url: string;
  /** Whether maintainers may push to a fork PR's branch. */
  maintainer_can_modify?: boolean;
  /**
   * GitHub's computed merge state (`clean`, `dirty`, `behind`, `unstable`,
   * `blocked`, `unknown`...). Recomputed asynchronously, so it can lag a
   * recent push; absent while GitHub has never computed it.
   */
  mergeable_state?: string;
  /** Draft PRs are never auto-merged. */
  draft?: boolean;
  /** Total changed files (the files API stops listing at 3000). */
  changed_files?: number;
}

/** One changed file from `GET /pulls/{n}/files`. */
export interface PullRequestFile {
  filename: string;
  status: string;
  /** Set for renamed/copied files. */
  previous_filename?: string;
}

/** Result of `PUT /pulls/{n}/merge`. */
export interface PullRequestMergeResult {
  merged: boolean;
  sha?: string;
  message?: string;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
}

export interface CombinedStatus {
  state: "error" | "failure" | "pending" | "success";
  total_count: number;
  statuses: Array<{
    id: number;
    state: string;
    context?: string;
    target_url?: string | null;
  }>;
}

/** One check run from `GET /commits/{ref}/check-runs` (Checks API). */
export interface CheckRun {
  id: number;
  name: string;
  /** `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`. */
  status: string;
  /** Set once `completed`: `success`, `failure`, `neutral`, `skipped`, ... */
  conclusion: string | null;
}

export interface ActionJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface WorkflowRunSummary {
  id: number;
  name?: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

/** Target and content for a new inline review comment. */
export interface CreateReviewCommentOptions {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  commitId: string;
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
}
