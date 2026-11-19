/**
 * Overview's "Queued" disclosure: work the worker has accepted but not
 * started (ad-hoc tasks, dashboard retries, webhook deliveries, automations
 * waiting for a free slot, and PR jobs waiting for a slot or for their PR). Closed by
 * default so active work keeps the panel; each row opens in place to show
 * what will run, for which repo, and why it may be held back.
 */

import { ArrowRight, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { formatIn } from "@/components/overview/overview-model";
import { TaskDescription } from "@/components/TaskDescription";
import { TicketKey } from "@/components/TicketKey";
import type { QueuedWorkItem, QueuedWorkKind } from "@/lib/api";
import { automationHash, runHash } from "@/lib/routes";
import { formatPastTime, formatTime } from "@/lib/utils";

const KIND_LABELS: Record<QueuedWorkKind, string> = {
  "ad-hoc": "Ad-hoc task",
  retry: "Retry",
  webhook: "PR event",
  automation: "Automation",
  "pr-job": "PR job",
  tracker: "Tracker ticket",
};

/** Whether the item is backing off and cannot be picked up yet. */
function heldUntil(item: QueuedWorkItem, now: number): number | undefined {
  return item.notBefore !== undefined && item.notBefore > now ? item.notBefore : undefined;
}

/** One-line reason under the kind label: backoff, failed attempts, or who queued it. */
function statusDetail(item: QueuedWorkItem, now: number): string | undefined {
  if (item.dependencyState) {
    const label = item.dependencyState === "blocked" ? "Blocked" : "Waiting";
    return item.dependencyReason ? `${label}: ${item.dependencyReason}` : label;
  }
  const held = heldUntil(item, now);
  if (held !== undefined) {
    const times = item.deferCount ? ` · deferred ${item.deferCount}×` : "";
    return `Backing off${times}`;
  }
  if (item.attempts)
    return `${item.attempts} failed ${item.attempts === 1 ? "attempt" : "attempts"}`;
  if (item.kind === "automation") return "Waiting for a slot";
  if (item.kind === "pr-job") {
    return item.waitingOn === "exclusive" ? "Waiting for this PR" : "Waiting for a slot";
  }
  if (item.actor) return `Queued by ${item.actor}`;
  return undefined;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function QueuedDetails({ item, now }: { item: QueuedWorkItem; now: number }) {
  const held = heldUntil(item, now);
  return (
    <div className="aq-body">
      <dl className="aq-facts">
        <Fact label="Source">{KIND_LABELS[item.kind]}</Fact>
        {item.taskKey ? <Fact label="Task">{item.taskKey}</Fact> : null}
        {item.repo ? <Fact label="Repository">{item.repo}</Fact> : null}
        {item.eventType ? <Fact label="Event">{item.eventType}</Fact> : null}
        {item.prNumber !== undefined ? (
          <Fact label="Pull request">
            <TicketKey label={`#${item.prNumber}`} href={item.prUrl} />
          </Fact>
        ) : null}
        {item.actor ? (
          <Fact label={item.kind === "automation" ? "Started by" : "Queued by"}>{item.actor}</Fact>
        ) : null}
        <Fact label="Queued">{formatTime(item.createdAt)}</Fact>
        {held !== undefined ? (
          <Fact label="Eligible">
            {formatTime(held)} ({formatIn(held, now)})
          </Fact>
        ) : null}
        {item.dependsOn?.length ? (
          <Fact label="Depends on">
            {item.dependsOn.join(", ")} ({item.dependencyMode ?? "merged"})
          </Fact>
        ) : null}
        {item.dependencyState && item.dependencyReason ? (
          <Fact label={item.dependencyState === "blocked" ? "Blocked" : "Waiting"}>
            {item.dependencyState === "blocked" ? (
              <span className="text-danger">{item.dependencyReason}</span>
            ) : (
              item.dependencyReason
            )}
          </Fact>
        ) : null}
        {item.deferCount ? <Fact label="Deferrals">{item.deferCount}</Fact> : null}
        {item.attempts ? <Fact label="Attempts">{item.attempts}</Fact> : null}
        {item.message ? (
          <Fact
            label={item.kind === "automation" || item.kind === "pr-job" ? "Waiting" : "Last note"}
          >
            {item.message}
          </Fact>
        ) : null}
        {item.lastError ? (
          <Fact label="Last error">
            <span className="text-danger">{item.lastError}</span>
          </Fact>
        ) : null}
      </dl>
      {item.runId !== undefined ? (
        <a className="aq-link" href={runHash(item.runId)}>
          Open the run being retried
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      ) : null}
      {item.automationId !== undefined ? (
        <a className="aq-link" href={automationHash(item.automationId)}>
          Open the automation
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      ) : null}
      {item.kind === "ad-hoc" ? (
        <div className="aq-prompt">
          <TaskDescription description={item.body} title={item.title} />
          {item.bodyTruncated ? (
            <p className="mt-2 text-xs text-subtle-foreground">Prompt shortened for display.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function QueuedRow({ item, now }: { item: QueuedWorkItem; now: number }) {
  const held = heldUntil(item, now);
  const detail = statusDetail(item, now);
  const repo = item.repo?.split("/").pop();
  return (
    <li className="aq-item">
      <details>
        <summary className="aw-row" data-kind="queued">
          <div className="aw-main">
            <span className="aq-title" title={item.title}>
              <ChevronRight className="size-3.5" aria-hidden="true" />
              {item.title}
            </span>
            <div className="aw-meta">
              {item.taskKey && item.taskKey !== item.title ? <span>{item.taskKey}</span> : null}
              {repo ? <span title={item.repo}>{repo}</span> : null}
            </div>
          </div>
          <div className="aw-status">
            <span className="aw-phase text-muted-foreground">
              <span className="aw-phase-label">
                <span className="status-dot" aria-hidden="true" />
                {KIND_LABELS[item.kind]}
              </span>
            </span>
            {detail ? (
              <span className="aw-detail" title={detail}>
                {detail}
              </span>
            ) : null}
          </div>
          {held !== undefined ? (
            <time
              className="aw-time"
              dateTime={new Date(held).toISOString()}
              title={`Eligible ${formatTime(held)}`}
            >
              {formatIn(held, now)}
            </time>
          ) : (
            <time
              className="aw-time"
              dateTime={new Date(item.createdAt).toISOString()}
              title={`Queued ${formatTime(item.createdAt)}`}
            >
              {formatPastTime(item.createdAt, now)}
            </time>
          )}
        </summary>
        <QueuedDetails item={item} now={now} />
      </details>
    </li>
  );
}

/** A closed disclosure of pending work; renders nothing when the queue is empty. */
export function QueuedWork({
  items,
  total,
  now,
}: {
  items: QueuedWorkItem[];
  /** Every pending item, including any beyond `items`. */
  total: number;
  now: number;
}) {
  if (items.length === 0) return null;
  const hidden = Math.max(0, total - items.length);
  return (
    <details className="aw-finished aw-queued">
      <summary>
        <ChevronRight className="size-4" aria-hidden="true" />
        Queued <span className="aw-count">{total}</span>
        <span className="aq-next" title={items[0]!.title}>
          next: {items[0]!.title}
        </span>
      </summary>
      <ul className="aw-list" aria-label="Queued work">
        {items.map((item) => (
          <QueuedRow key={item.id} item={item} now={now} />
        ))}
        {hidden > 0 ? (
          <li className="aq-more">
            {hidden} more queued {hidden === 1 ? "item" : "items"} not shown
          </li>
        ) : null}
      </ul>
    </details>
  );
}
