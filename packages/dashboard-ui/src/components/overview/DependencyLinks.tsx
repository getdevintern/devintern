/**
 * Linked task dependencies: each dependency key opens its latest run (or its
 * own queued row when it has no run yet), shows where it stands, and offers
 * the run page's retry action inline when that run can be re-queued, so a
 * blocked task can be unblocked from the queue. Also used in reverse on the
 * run page to list the queued tasks a task blocks.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import { requestQueuedFocus } from "@/components/overview/focus";
import { Button } from "@/components/ui/button";
import { notifyQueueChanged, triggerRunRetry } from "@/lib/api";
import type { TaskLink, TaskLinkStatus } from "@/lib/api";
import { isDemoMode } from "@/lib/demo";
import { runHash } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { RetryConfirm, RetryFeedback } from "@/views/run-detail/RetryParts";

const STATUS_LABELS: Record<TaskLinkStatus, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  unknown: "unknown",
};

const STATUS_CLASSES: Partial<Record<TaskLinkStatus, string>> = {
  failed: "text-danger",
  done: "text-success",
  cancelled: "text-subtle-foreground",
  unknown: "text-subtle-foreground",
};

/**
 * A task key that opens where its work is: its newest run, else its queued
 * row in the Overview, else plain text (nothing recorded to open).
 */
export function TaskKeyLink({
  taskKey,
  runId,
  queuedItemId,
  children,
}: {
  taskKey: string;
  runId?: number;
  queuedItemId?: string;
  children?: ReactNode;
}) {
  const label = children ?? <code className="font-mono">{taskKey}</code>;
  if (runId !== undefined) {
    return (
      <a href={runHash(runId)} className="ref-link" title={`Open the latest run of ${taskKey}`}>
        {label}
      </a>
    );
  }
  if (queuedItemId !== undefined) {
    return (
      <a
        href="#/"
        className="ref-link"
        title={`Show ${taskKey} in the queue`}
        onClick={() => requestQueuedFocus(queuedItemId)}
      >
        {label}
      </a>
    );
  }
  return <span>{label}</span>;
}

const RETRY_LABELS: Record<NonNullable<TaskLink["retryKind"]>, string> = {
  injected: "Re-queue",
  task: "Retry",
  automation: "Re-run",
};

/**
 * The run page's retry action for a dependency's latest run, inline. A
 * successful retry refreshes every queue poll so the dependent's state
 * moves from Blocked to Waiting on the next read.
 */
function DependencyRetry({ link }: { link: TaskLink }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );
  const runId = link.latestRunId;
  const kind = link.retryKind;
  if (runId === undefined || kind === undefined || isDemoMode()) return null;
  if (feedback?.kind === "success") return <RetryFeedback {...feedback} />;

  const retry = async () => {
    setBusy(true);
    try {
      const { ok, body } = await triggerRunRetry(runId);
      if (ok) {
        setConfirming(false);
        setFeedback({
          kind: "success",
          message:
            kind === "injected"
              ? `Re-queued. The worker will resume ${link.key} on its next poll.`
              : `Retry started for ${link.key}.`,
        });
        notifyQueueChanged();
      } else {
        setFeedback({ kind: "error", message: body.error ?? "Could not trigger the retry." });
      }
    } catch (cause: unknown) {
      setFeedback({
        kind: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aq-dep-retry">
      {confirming ? (
        <RetryConfirm
          taskKey={link.key}
          kind={kind}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void retry()}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-dependency-retry={link.key}
          onClick={() => {
            setFeedback(null);
            setConfirming(true);
          }}
        >
          {RETRY_LABELS[kind]}
        </Button>
      )}
      {feedback ? <RetryFeedback {...feedback} /> : null}
    </div>
  );
}

/** Dependency keys with their status, each linked, with a retry for a failed one. */
export function DependencyList({
  links,
  stackedOn,
}: {
  links: readonly TaskLink[];
  stackedOn?: string;
}) {
  return (
    <ul className="aq-deps" aria-label="Dependencies">
      {links.map((link) => (
        <li key={link.key} className="aq-dep">
          <span className="aq-dep-head">
            <TaskKeyLink
              taskKey={link.key}
              runId={link.status === "unknown" ? undefined : link.latestRunId}
              queuedItemId={link.status === "unknown" ? undefined : link.queuedItemId}
            />
            <span className={cn("text-xs", STATUS_CLASSES[link.status])}>
              {STATUS_LABELS[link.status]}
            </span>
            {link.key === stackedOn ? (
              <span className="text-xs text-subtle-foreground">stack base</span>
            ) : null}
          </span>
          <DependencyRetry link={link} />
        </li>
      ))}
    </ul>
  );
}
