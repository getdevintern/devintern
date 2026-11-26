import { useState } from "react";
import { ArrowRight, Bell } from "lucide-react";

import { useNow } from "@/components/overview/use-now";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePoll } from "@/lib/api";
import {
  NOTIFICATION_UNREAD_URL,
  NOTIFICATIONS_CHANGED_EVENT,
  notificationsUrl,
} from "@/lib/api-notifications";
import type { NotificationListResponse, NotificationUnreadResponse } from "@/lib/api-notifications";
import { INBOX_HASH } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { NotificationSummaryList } from "./NotificationSummaryList";
// oxlint-disable-next-line import/no-unassigned-import -- bell bubble and unread row styles
import "./notifications.css";

/** Same cadence as the dashboard's other live polls (worker, queue, runs). */
export const NOTIFICATION_POLL_MS = 5000;

/** Latest rows the popover lists. */
const POPOVER_LIMIT = 6;

/** Count shown on the bell: "99+" past two digits. */
export function bellCountText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Accessible name of the bell button, e.g. "Notifications: 5 unread, 2 need you". */
export function bellLabel(counts: NotificationUnreadResponse | null): string {
  if (!counts || counts.unread === 0) return "Notifications: none unread";
  const high = counts.unreadHigh > 0 ? `, ${counts.unreadHigh} need you` : "";
  return `Notifications: ${counts.unread} unread${high}`;
}

/**
 * Bell glyph with its unread bubble. High-severity unread rows switch the
 * bubble to the attention style and add a "!" so the emphasis does not rely
 * on color alone.
 */
export function BellIndicator({ counts }: { counts: NotificationUnreadResponse | null }) {
  const unread = counts?.unread ?? 0;
  const high = counts?.unreadHigh ?? 0;
  return (
    <span className="relative inline-flex" aria-hidden="true">
      <Bell className="size-4" />
      {unread > 0 ? (
        <span
          data-slot="bell-count"
          data-high={high > 0 ? "true" : undefined}
          className={cn(
            "notification-bell-count tabular",
            high > 0 && "notification-bell-count-high",
          )}
        >
          {high > 0 ? `${bellCountText(high)}!` : bellCountText(unread)}
        </span>
      ) : null}
    </span>
  );
}

function PopoverList({ onNavigate }: { onNavigate: () => void }) {
  const { data, error } = usePoll<NotificationListResponse>(
    notificationsUrl({ unresolved: true, limit: POPOVER_LIMIT }),
    NOTIFICATION_POLL_MS,
    { refreshOn: NOTIFICATIONS_CHANGED_EVENT },
  );
  const now = useNow(15_000);
  if (!data) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {error ? `Could not load notifications: ${error}` : "Loading…"}
      </p>
    );
  }
  if (data.notifications.length === 0) {
    return <p className="px-3 py-4 text-xs text-muted-foreground">Nothing open. All caught up.</p>;
  }
  return (
    <NotificationSummaryList
      label="Latest notifications"
      notifications={data.notifications}
      now={now}
      onNavigate={onNavigate}
    />
  );
}

/** Header bell: unread count, and a popover with the latest open items. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data } = usePoll<NotificationUnreadResponse>(
    NOTIFICATION_UNREAD_URL,
    NOTIFICATION_POLL_MS,
    { refreshOn: NOTIFICATIONS_CHANGED_EVENT },
  );
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="notification-bell inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-expanded:bg-hover aria-expanded:text-foreground"
        aria-label={bellLabel(data)}
      >
        <BellIndicator counts={data} />
      </PopoverTrigger>
      <PopoverContent aria-label="Notifications">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
          <span className="text-[0.8125rem] font-semibold">Notifications</span>
          {data && data.unread > 0 ? (
            <span className="text-xs text-subtle-foreground">
              {data.unread} unread
              {data.unreadHigh > 0 ? ` · ${data.unreadHigh} need you` : ""}
            </span>
          ) : null}
        </div>
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
          <PopoverList onNavigate={close} />
        </div>
        <a
          href={INBOX_HASH}
          onClick={close}
          className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2.5 text-xs font-medium text-primary no-underline outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
        >
          Open inbox
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </a>
      </PopoverContent>
    </Popover>
  );
}
