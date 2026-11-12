import { Button } from "@/components/ui/button";
import type { RetryAuditEntry } from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";

/** Outcome banner after a retry attempt (success and failure are terminal). */
export function RetryFeedback({ kind, message }: { kind: "success" | "error"; message: string }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        kind === "success"
          ? "border-success-border bg-success-subtle text-success"
          : "border-danger-border bg-danger-subtle text-danger",
      )}
    >
      {message}
    </div>
  );
}

/** Inline confirmation strip shown between the first click and the POST. */
export function RetryConfirm({
  taskKey,
  kind = "task",
  busy,
  onCancel,
  onConfirm,
}: {
  taskKey?: string;
  kind?: "task" | "automation" | "injected";
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const automation = kind === "automation";
  const injected = kind === "injected";
  return (
    <div className="rounded-md border border-border bg-muted px-3 py-2.5">
      <p className="max-w-[72ch] text-[0.8125rem] text-muted-foreground">
        {automation ? (
          <>Start a new run of this automation? The current run stays in history.</>
        ) : injected ? (
          <>
            Re-queue {taskKey ? <code className="font-mono">{taskKey}</code> : "this ad-hoc task"}?
            The worker resumes the branch and report the interrupted run left behind, when it
            recorded them. The current run stays in history.
          </>
        ) : (
          <>
            Schedule a new run of{" "}
            {taskKey ? <code className="font-mono">{taskKey}</code> : "this task"}? This bypasses
            the retry limit. The current run stays in history.
          </>
        )}
      </p>
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" variant="destructive" onClick={onConfirm} disabled={busy}>
          {busy
            ? automation
              ? "Triggering…"
              : injected
                ? "Re-queuing…"
                : "Scheduling…"
            : automation
              ? "Start new run"
              : injected
                ? "Re-queue task"
                : "Schedule retry"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Audited retry history: who re-ran this run's task, when, and how. */
export function RetryAuditList({ entries }: { entries: RetryAuditEntry[] }) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="rd-retry-history">
      <h3 id="rd-retry-history" className="section-title mb-2">
        Retry history
      </h3>
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="text-[0.8125rem]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={entry.action === "failed" ? "text-danger" : "text-success"}>
                {entry.action}
              </span>
              <span>by {entry.actor}</span>
              <span className="tabular text-xs text-subtle-foreground">
                {formatTime(entry.createdAt)}
                {entry.pid !== undefined ? ` · pid ${entry.pid}` : ""}
              </span>
            </div>
            {entry.message ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{entry.message}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
