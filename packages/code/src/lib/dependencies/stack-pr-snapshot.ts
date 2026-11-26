/**
 * Parse a GitHub single-PR payload into the {@link StackPrSnapshot} the stack
 * maintainer and a stacked run's base check read. Shared by the fleet's
 * stacked-PR adapter (`workspace/stacked-pr-acquirer.ts`) and the task run's
 * PR client (`code-host/github/pr-client.ts`).
 */

import type { StackPrSnapshot } from "./stack-maintainer";

/** GitHub single-PR payload fields the adapter reads (untrusted). */
export interface GitHubPrPayload {
  state?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  html_url?: unknown;
  head?: { ref?: unknown; sha?: unknown };
  base?: { ref?: unknown };
}

/** Parse a GitHub PR payload into a {@link StackPrSnapshot}; `null` when unusable. */
export function parseStackPr(number: number, data: GitHubPrPayload): StackPrSnapshot | null {
  const headRef = data.head?.ref;
  const headSha = data.head?.sha;
  const baseRef = data.base?.ref;
  if (typeof headRef !== "string" || typeof headSha !== "string" || typeof baseRef !== "string") {
    return null;
  }
  let state: StackPrSnapshot["state"];
  if (data.state === "open") {
    state = "open";
  } else if (data.state === "closed") {
    const merged =
      data.merged === true || (typeof data.merged_at === "string" && data.merged_at !== "");
    if (!merged && data.merged !== false) return null;
    state = merged ? "merged" : "closed";
  } else {
    return null;
  }
  return {
    number,
    state,
    headRef,
    headSha,
    baseRef,
    url: typeof data.html_url === "string" ? data.html_url : undefined,
  };
}
