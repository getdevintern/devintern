import { isUnread } from "@/lib/api-notifications";
import type { NotificationRecord } from "@/lib/api-notifications";
import { INBOX_HASH, runHash } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { GroupCount, KindIcon, NotificationAge, UnreadMarker } from "./NotificationParts";

/** Where a compact row leads: its run when it has one, otherwise the inbox. */
export function summaryHref(notification: NotificationRecord): string {
  return notification.runId !== undefined ? runHash(notification.runId) : INBOX_HASH;
}

/**
 * Compact notification list for the bell popover and the overview block:
 * icon, title, count, repo, age. Each row is one link.
 */
export function NotificationSummaryList({
  notifications,
  now,
  onNavigate,
  label,
}: {
  notifications: readonly NotificationRecord[];
  now: number;
  /** Called after a row link is followed (the popover closes). */
  onNavigate?: () => void;
  label: string;
}) {
  return (
    <ul aria-label={label} className="divide-y divide-border" data-slot="notification-summary">
      {notifications.map((notification) => {
        const unread = isUnread(notification);
        return (
          <li key={notification.id} data-notification-id={notification.id}>
            <a
              href={summaryHref(notification)}
              onClick={onNavigate}
              className="flex items-start gap-2.5 px-3 py-2.5 no-underline outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
            >
              <KindIcon kind={notification.kind} size="sm" />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "min-w-0 truncate text-[0.8125rem] text-foreground",
                      unread ? "font-semibold" : "font-medium",
                    )}
                  >
                    {notification.title}
                  </span>
                  <GroupCount count={notification.count} />
                </span>
                <span className="flex min-w-0 items-center gap-2 text-xs text-subtle-foreground">
                  {unread ? <UnreadMarker /> : null}
                  {notification.repo ? (
                    <span className="truncate font-mono">{notification.repo}</span>
                  ) : null}
                  <NotificationAge at={notification.updatedAt} now={now} />
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
