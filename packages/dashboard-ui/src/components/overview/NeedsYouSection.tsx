import { ArrowRight } from "lucide-react";

import { NotificationSummaryList } from "@/components/notifications/NotificationSummaryList";
import { notificationsUrl } from "@/lib/api-notifications";
import type { NotificationListResponse } from "@/lib/api-notifications";
import { INBOX_HASH } from "@/lib/routes";

/** Top unresolved high-severity rows the overview lists. */
export const NEEDS_YOU_LIMIT = 5;

export const NEEDS_YOU_URL = notificationsUrl({
  unresolved: true,
  severity: "high",
  limit: NEEDS_YOU_LIMIT,
});

/** Open escalations (always high severity); only its `total` is read. */
export const WAITING_ON_REVIEW_URL = notificationsUrl({
  unresolved: true,
  kind: "escalated",
  limit: 1,
});

/**
 * "2 need attention · 5 waiting on review": escalations waiting on a human
 * are counted apart from everything else that needs you (DevIntern problems,
 * exhausted retries, broken automations, unhealthy sources).
 */
export function needsYouCounts(total: number, waitingOnReview: number | undefined): string {
  if (waitingOnReview === undefined) return String(total);
  const waiting = Math.min(Math.max(waitingOnReview, 0), total);
  const attention = total - waiting;
  return `${attention} need${attention === 1 ? "s" : ""} attention · ${waiting} waiting on review`;
}

/** "Needs you" for one list response; renders nothing when nothing is open. */
export function NeedsYouBlock({
  list,
  now,
  waitingOnReview,
}: {
  list: NotificationListResponse | null;
  now: number;
  /** Open escalations, from {@link WAITING_ON_REVIEW_URL}; the split is omitted while unknown. */
  waitingOnReview?: number;
}) {
  if (!list || list.notifications.length === 0) return null;
  const more = list.total - list.notifications.length;
  return (
    <section
      aria-labelledby="overview-needs-you"
      data-slot="needs-you"
      className="overflow-hidden rounded-lg border border-attention-border bg-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
        <h2 id="overview-needs-you" className="section-title">
          Needs you{" "}
          <span className="tabular text-subtle-foreground" data-slot="needs-you-counts">
            · {needsYouCounts(list.total, waitingOnReview)}
          </span>
        </h2>
        <a href={INBOX_HASH} className="ref-link inline-flex items-center gap-1 text-xs">
          {more > 0 ? `View all ${list.total}` : "Open inbox"}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      </div>
      <NotificationSummaryList label="Needs you" notifications={list.notifications} now={now} />
    </section>
  );
}
