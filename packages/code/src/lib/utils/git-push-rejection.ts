/**
 * Parse `git push` output for a server-side refusal of the branch update.
 *
 * Git prints one ref-status line per pushed ref. A `! [remote rejected]`
 * line carries the reason the remote gave (GitHub's `workflow` scope check,
 * protected-branch GH006 rules, GH013 push protection, a server pre-receive
 * hook). Nothing in the worktree can change those, so callers must not hand
 * them to the local hook-fix agent. A failing local pre-push hook stops git
 * before it contacts the remote and never produces this line.
 */

/** A server-side refusal of one pushed ref. */
export interface RemotePushRejection {
  /** Destination ref as git printed it (e.g. `feature/x` or `refs/heads/feature/x`). */
  ref: string;
  /** Reason the remote gave, whitespace-collapsed. */
  reason: string;
  /** Workflow file named by GitHub's workflow-permission refusal, if any. */
  workflowFile?: string;
}

const REMOTE_REJECTED_LINE = /^\s*!\s*\[remote rejected\]\s+\S+\s+->\s+(\S+)\s+\(([^)]*)\)/gim;

const WORKFLOW_PERMISSION =
  /refusing to allow an? .+? to create or update workflow\s+`([^`]+)`\s+without\s+`?workflows?`?\s+(?:scope|permission)/i;

function stripHeadsPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/**
 * Find the server-side rejection of `branch` in combined push output.
 *
 * Matching only the pushed branch keeps arbitrary text a local hook echoes
 * (for example a git test suite's fixtures) from looking like a refusal.
 * The reason may wrap across lines in captured logs, so the parenthesised
 * reason is matched up to its closing parenthesis.
 *
 * @param output - Combined stdout and stderr of `git push`
 * @param branch - Branch that was pushed
 * @returns The rejection, or `undefined` when the remote did not refuse it
 */
export function findRemotePushRejection(
  output: string,
  branch: string,
): RemotePushRejection | undefined {
  for (const match of output.matchAll(REMOTE_REJECTED_LINE)) {
    const ref = match[1];
    if (stripHeadsPrefix(ref) !== branch) continue;
    const reason = match[2].replace(/\s+/g, " ").trim();
    const workflowFile = WORKFLOW_PERMISSION.exec(reason)?.[1];
    return { ref, reason, ...(workflowFile ? { workflowFile } : {}) };
  }
  return undefined;
}

/**
 * Build a failure message that leads with the server's reason and, for the
 * GitHub workflow-permission refusal, names the file and the token fix.
 *
 * @param rejection - Parsed server-side rejection
 * @param branch - Branch that was pushed
 * @returns A one-line, user-facing failure message
 */
export function describeRemotePushRejection(
  rejection: RemotePushRejection,
  branch: string,
): string {
  if (rejection.workflowFile) {
    return (
      `Push of '${branch}' rejected by the remote: the push token cannot create or update ` +
      `workflow file '${rejection.workflowFile}'. Give the token the \`workflow\` scope ` +
      `(classic personal access token) or Workflows read and write permission ` +
      `(fine-grained token or GitHub App), or leave .github/workflows/ unchanged. ` +
      `Remote said: ${rejection.reason}`
    );
  }
  return (
    `Push of '${branch}' rejected by the remote: ${rejection.reason}. ` +
    `This is a server-side rule (branch protection, push protection, or repository ` +
    `permissions), not a local git hook, so it was not sent to the hook-fix agent.`
  );
}
