import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { EmptyState, FilterGroup } from "@/components/shared";
import { TicketKey } from "@/components/TicketKey";
import { usePoll } from "@/lib/api";
import type { AgentPrRecord, AgentPrsResponse } from "@/lib/api";
import { cn, formatAge, formatTime } from "@/lib/utils";

// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./prs.css";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A PR waiting longer than this is flagged as stale (needs a human soon). */
export const STALE_AFTER_MS = 7 * DAY_MS;

/** Which slice of the agent PR registry the view shows. */
export type AgentPrsFilter = "open" | "merged";

const PR_FILTERS: readonly AgentPrsFilter[] = ["open", "merged"];

function filterLabel(filter: AgentPrsFilter): string {
  return filter === "open" ? "Open" : "Merged";
}

/** Oldest-waiting first: those are the ones a reviewer should look at next. */
export function sortOldestFirst(prs: AgentPrRecord[]): AgentPrRecord[] {
  return [...prs].sort((a, b) => a.createdAt - b.createdAt);
}

/** Most recently merged first; rows without a merge time sink to the end. */
export function sortRecentlyMergedFirst(prs: AgentPrRecord[]): AgentPrRecord[] {
  return [...prs].sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0));
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

function PrCells({ pr }: { pr: AgentPrRecord }) {
  return (
    <>
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
    </>
  );
}

function PrHead({ ageLabel }: { ageLabel: string }) {
  return (
    <div role="row" className="prs-row prs-head">
      <span role="columnheader">Pull request</span>
      <span role="columnheader">Ticket</span>
      <span role="columnheader">Branch</span>
      <span role="columnheader" className="text-right">
        {ageLabel}
      </span>
    </div>
  );
}

/**
 * The open agent PRs, oldest-waiting first. Each row links straight to the PR
 * on GitHub so a finished run is one click from review. Registry rows are
 * reconciled with GitHub by the worker's review polling, so merged or closed
 * PRs drop out within one poll cycle.
 */
export function AgentPrsTable({
  prs,
  now = Date.now(),
  controls,
}: {
  prs: AgentPrRecord[];
  now?: number;
  /** Rendered at the start of the toolbar (the Open/Merged switch). */
  controls?: ReactNode;
}) {
  const sorted = sortOldestFirst(prs);
  const staleCount = sorted.filter((pr) => now - pr.createdAt > STALE_AFTER_MS).length;

  return (
    <div>
      <div className="toolbar">
        {controls}
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
        <PrHead ageLabel="Waiting" />
        {sorted.map((pr) => {
          const waitingMs = now - pr.createdAt;
          const stale = waitingMs > STALE_AFTER_MS;
          return (
            <div role="row" key={`${pr.provider ?? ""}:${pr.prUrl}`} className="prs-row prs-item">
              <PrCells pr={pr} />
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

/**
 * Agent PRs the worker saw merged, most recently merged first, so what landed
 * is visible without opening GitHub. Merges are recorded when the worker's
 * polling observes them; PRs closed before that was recorded are not listed.
 */
export function MergedAgentPrsTable({
  prs,
  now = Date.now(),
  controls,
}: {
  prs: AgentPrRecord[];
  now?: number;
  /** Rendered at the start of the toolbar (the Open/Merged switch). */
  controls?: ReactNode;
}) {
  const sorted = sortRecentlyMergedFirst(prs);
  return (
    <div>
      <div className="toolbar">
        {controls}
        <p className="muted-text text-sm">
          <span className="font-medium text-foreground tabular-nums">{sorted.length}</span> recently
          merged PR{sorted.length === 1 ? "" : "s"}
        </p>
      </div>
      <div role="table" aria-label="Merged agent pull requests" className="prs-list">
        <PrHead ageLabel="Merged" />
        {sorted.map((pr) => (
          <div role="row" key={`${pr.provider ?? ""}:${pr.prUrl}`} className="prs-row prs-item">
            <PrCells pr={pr} />
            <span
              role="cell"
              className="prs-age muted-text"
              title={
                pr.mergedAt !== undefined
                  ? `Merged ${formatTime(pr.mergedAt)} · opened ${formatTime(pr.createdAt)}`
                  : `Opened ${formatTime(pr.createdAt)}`
              }
            >
              {pr.mergedAt !== undefined ? formatAge(pr.mergedAt, now) : "–"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OpenAgentPrs({ controls }: { controls: ReactNode }) {
  const { data, error } = usePoll<AgentPrsResponse>("/api/agent-prs");
  if (data && data.prs.length > 0) return <AgentPrsTable prs={data.prs} controls={controls} />;
  return (
    <>
      <div className="toolbar">{controls}</div>
      {error ? <EmptyState title="Could not load agent PRs" body={error} /> : null}
      {data ? (
        <EmptyState
          title="No open agent PRs"
          body="Pull requests created by the worker are listed here while they await review."
        />
      ) : null}
    </>
  );
}

function MergedAgentPrs({ controls }: { controls: ReactNode }) {
  const { data, error } = usePoll<AgentPrsResponse>("/api/agent-prs?state=merged", 30_000);
  if (data && data.prs.length > 0) {
    return <MergedAgentPrsTable prs={data.prs} controls={controls} />;
  }
  return (
    <>
      <div className="toolbar">{controls}</div>
      {error ? <EmptyState title="Could not load merged PRs" body={error} /> : null}
      {data ? (
        <EmptyState
          title="No merged agent PRs yet"
          body="Pull requests created by the worker show up here once the worker sees them merged."
        />
      ) : null}
    </>
  );
}

/** Agent PRs with direct GitHub links: open ones awaiting review, or recently merged. */
export function AgentPrsView() {
  const [filter, setFilter] = useState<AgentPrsFilter>("open");
  const controls = (
    <FilterGroup
      options={PR_FILTERS}
      value={filter}
      onChange={setFilter}
      formatLabel={filterLabel}
    />
  );

  // Separate components (each with its own poll) so switching never shows the
  // other list's stale data while the new request is in flight.
  return (
    <div className="space-y-4">
      {filter === "open" ? (
        <OpenAgentPrs controls={controls} />
      ) : (
        <MergedAgentPrs controls={controls} />
      )}
    </div>
  );
}
