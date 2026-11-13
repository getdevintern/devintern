import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { usePoll } from "@/lib/api";
import type { AgentPrRecord, AgentPrsResponse } from "@/lib/api";
import { cn, formatAge, formatTime } from "@/lib/utils";

// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./prs.css";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A PR waiting longer than this is flagged as stale (needs a human soon). */
export const STALE_AFTER_MS = 7 * DAY_MS;

/** Oldest-waiting first: those are the ones a reviewer should look at next. */
export function sortOldestFirst(prs: AgentPrRecord[]): AgentPrRecord[] {
  return [...prs].sort((a, b) => a.createdAt - b.createdAt);
}

function CopyBranch({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(branch)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Branch copied" : `Copy branch ${branch}`}
      title="Copy branch name"
      className="prs-copy"
    >
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * The open agent PRs, oldest-waiting first. Each row links straight to the PR
 * on GitHub so a finished run is one click from review. Registry rows are
 * reconciled with GitHub by the worker's review polling, so merged or closed
 * PRs drop out within one poll cycle.
 */
export function AgentPrsTable({ prs, now = Date.now() }: { prs: AgentPrRecord[]; now?: number }) {
  const sorted = sortOldestFirst(prs);
  const staleCount = sorted.filter((pr) => now - pr.createdAt > STALE_AFTER_MS).length;

  return (
    <div>
      <div className="toolbar">
        <p className="muted-text text-sm">
          <span className="font-medium text-foreground tabular-nums">{sorted.length}</span> open PR
          {sorted.length === 1 ? "" : "s"} awaiting review
          {staleCount > 0 ? (
            <>
              {" · "}
              <span className="text-attention tabular-nums">{staleCount} waiting over 7 days</span>
            </>
          ) : null}
        </p>
      </div>
      <div role="table" aria-label="Open agent pull requests" className="prs-list">
        <div role="row" className="prs-row prs-head">
          <span role="columnheader">Pull request</span>
          <span role="columnheader">Ticket</span>
          <span role="columnheader">Branch</span>
          <span role="columnheader" className="text-right">
            Waiting
          </span>
        </div>
        {sorted.map((pr) => {
          const waitingMs = now - pr.createdAt;
          const stale = waitingMs > STALE_AFTER_MS;
          return (
            <div role="row" key={`${pr.repo}#${pr.prNumber}`} className="prs-row prs-item">
              <span role="cell" className="prs-pr">
                <a href={pr.prUrl} target="_blank" rel="noreferrer" className="prs-pr-link">
                  <span className="subtle-text">{pr.repo}</span>
                  <span className="prs-num">#{pr.prNumber}</span>
                  <ExternalLink className="prs-ext size-3" aria-hidden="true" />
                </a>
              </span>
              <span role="cell" className="prs-ticket">
                <TicketKey label={pr.taskKey} href={pr.ticketUrl} />
              </span>
              <span role="cell" className="prs-branch">
                {pr.branch ? (
                  <>
                    <code title={pr.branch}>{pr.branch}</code>
                    <CopyBranch branch={pr.branch} />
                  </>
                ) : (
                  <span className="subtle-text">–</span>
                )}
              </span>
              <span
                role="cell"
                className={cn("prs-age", stale ? "text-attention" : "muted-text")}
                title={`Opened ${formatTime(pr.createdAt)}${stale ? " (over 7 days)" : ""}`}
              >
                {formatAge(pr.createdAt, now)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** List of open agent PRs with direct GitHub links. */
export function AgentPrsView() {
  const { data, error } = usePoll<AgentPrsResponse>("/api/agent-prs");

  return (
    <div className="space-y-4">
      {error ? <EmptyState title="Could not load agent PRs" body={error} /> : null}

      {data && data.prs.length === 0 ? (
        <EmptyState
          title="No open agent PRs"
          body="Pull requests created by the worker are listed here while they await review."
        />
      ) : null}

      {data && data.prs.length > 0 ? <AgentPrsTable prs={data.prs} /> : null}
    </div>
  );
}
