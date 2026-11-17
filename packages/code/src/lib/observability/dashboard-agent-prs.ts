/**
 * Dashboard view of the agent PR registry (`GET /api/agent-prs`): the wire
 * shape of one PR and the endpoint's query parsing.
 */

import type { CodeHostProvider } from "../code-host/index";
import type { AgentPr } from "../state/worker-state";

/** One agent PR as served by `GET /api/agent-prs` (open or merged list). */
export interface OpenAgentPrView {
  provider: CodeHostProvider;
  instanceUrl: string;
  projectId?: string;
  projectPath: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  branch?: string;
  taskKey?: string;
  ticketUrl?: string;
  /** When the worker saw the PR merged (epoch ms); set only in the merged list. */
  mergedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Most merged PRs `GET /api/agent-prs?state=merged` returns by default. */
export const DEFAULT_MERGED_PR_LIMIT = 50;
/** Upper bound accepted for the merged list's `limit` query param. */
export const MAX_MERGED_PR_LIMIT = 500;

export type AgentPrsQuery = { state: "open" } | { state: "merged"; limit: number };

/**
 * Parse `state` (open | merged, default open) and, for the merged list,
 * `limit` (1..500, default 50).
 */
export function parseAgentPrsQuery(params: URLSearchParams): AgentPrsQuery | { error: string } {
  const state = params.get("state") ?? "open";
  if (state === "open") return { state };
  if (state !== "merged") return { error: "state must be one of: open, merged" };
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_MERGED_PR_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MERGED_PR_LIMIT) {
    return { error: `limit must be between 1 and ${MAX_MERGED_PR_LIMIT}` };
  }
  return { state, limit };
}

/** Map a registry row to its dashboard wire shape. */
export function toAgentPrView(pr: AgentPr): OpenAgentPrView {
  return {
    provider: pr.provider,
    instanceUrl: pr.instanceUrl,
    projectId: pr.projectId,
    projectPath: pr.projectPath,
    repo: pr.repo,
    prNumber: pr.prNumber,
    prUrl: pr.webUrl,
    branch: pr.branch,
    taskKey: pr.taskKey,
    ticketUrl: pr.ticketUrl,
    ...(pr.mergedAt !== undefined ? { mergedAt: pr.mergedAt } : {}),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
  };
}
