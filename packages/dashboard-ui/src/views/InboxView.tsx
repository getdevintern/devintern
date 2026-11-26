import { useState } from "react";
import { BellOff, CheckCheck, Inbox } from "lucide-react";

import { NOTIFICATION_POLL_MS } from "@/components/notifications/NotificationBell";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { useNow } from "@/components/overview/use-now";
import { EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePoll } from "@/lib/api";
import {
  INBOX_TAB_LABELS,
  INBOX_TABS,
  inboxQuery,
  markAllNotificationsRead,
  muteNotificationGroup,
  NOTIFICATION_MUTES_URL,
  NOTIFICATIONS_CHANGED_EVENT,
  notificationsUrl,
  unmuteNotificationGroup,
} from "@/lib/api-notifications";
import type {
  InboxTab,
  NotificationListResponse,
  NotificationMutesResponse,
  NotificationRecord,
} from "@/lib/api-notifications";
import { isDemoMode } from "@/lib/demo";
import { formatTime } from "@/lib/utils";

const PAGE_SIZE = 50;
/** The API caps one page at 200 rows. */
const MAX_LIMIT = 200;

const EMPTY_COPY: Record<InboxTab, { title: string; body: string; resolvedBody: string }> = {
  needs_you: {
    title: "Nothing needs you",
    body: "Escalations, exhausted retries, broken automations, and unhealthy sources show up here until they are resolved.",
    resolvedBody:
      "No escalations, exhausted retries, broken automations, or unhealthy sources yet.",
  },
  activity: {
    title: "No recent activity",
    body: "PRs DevIntern opens or auto-merges and work it delegates show up here.",
    resolvedBody: "PRs DevIntern opens or auto-merges and work it delegates show up here.",
  },
  all: {
    title: "Inbox is empty",
    body: "Nothing is open right now. Turn on “Show resolved” to see earlier notifications.",
    resolvedBody: "DevIntern has not recorded any notifications yet.",
  },
};

/** Confirm before muting: say what will be hidden from now on. */
function MuteDialog({
  target,
  onClose,
}: {
  target: NotificationRecord | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    const result = await muteNotificationGroup(target.groupKey);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent data-slot="mute-dialog">
        <DialogHeader>
          <DialogTitle>Mute this group?</DialogTitle>
          <DialogDescription>
            Future notifications from the same cause as “{target?.title}” will be hidden from the
            bell, the inbox, and the overview. Notifications already in this group are hidden too.
            You can unmute it later under “Muted groups” at the bottom of the inbox.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-confirm-mute
            onClick={() => void confirm()}
            aria-busy={busy || undefined}
          >
            <BellOff aria-hidden="true" />
            Mute group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Muted group keys with an Unmute action, collapsed by default. */
function MutedGroups({ actionsEnabled }: { actionsEnabled: boolean }) {
  const { data } = usePoll<NotificationMutesResponse>(NOTIFICATION_MUTES_URL, 30_000, {
    refreshOn: NOTIFICATIONS_CHANGED_EVENT,
  });
  const [error, setError] = useState<string | null>(null);
  const mutes = data?.mutes ?? [];
  if (mutes.length === 0) return null;
  return (
    <details className="rounded-lg border border-border bg-card px-4 py-3 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        Muted groups ({mutes.length})
      </summary>
      <ul className="mt-3 grid gap-2" aria-label="Muted groups">
        {mutes.map((mute) => (
          <li key={mute.groupKey} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <code className="font-mono break-all text-foreground">{mute.groupKey}</code>
            <span className="text-subtle-foreground">muted {formatTime(mute.mutedAt)}</span>
            {actionsEnabled ? (
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Unmute ${mute.groupKey}`}
                onClick={() =>
                  void unmuteNotificationGroup(mute.groupKey).then((result) =>
                    setError(result.ok ? null : result.error),
                  )
                }
              >
                Unmute
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      ) : null}
    </details>
  );
}

/** The notification inbox: tabs by severity, resolved toggle, row actions. */
export function InboxView() {
  const [tab, setTab] = useState<InboxTab>("needs_you");
  const [showResolved, setShowResolved] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [muteTarget, setMuteTarget] = useState<NotificationRecord | null>(null);
  const [markAllBusy, setMarkAllBusy] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const actionsEnabled = !isDemoMode();
  const now = useNow(15_000);
  const { data, error } = usePoll<NotificationListResponse>(
    notificationsUrl(inboxQuery(tab, showResolved, limit)),
    NOTIFICATION_POLL_MS,
    { refreshOn: NOTIFICATIONS_CHANGED_EVENT },
  );

  const markAll = async () => {
    setMarkAllBusy(true);
    setMarkAllError(null);
    const result = await markAllNotificationsRead();
    setMarkAllBusy(false);
    if (!result.ok) setMarkAllError(result.error);
  };

  const rows = data?.notifications ?? [];
  const empty = EMPTY_COPY[tab];
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onValueChange={(next) => {
            setTab(next as InboxTab);
            setLimit(PAGE_SIZE);
          }}
        >
          <TabsList aria-label="Notification filter">
            {INBOX_TABS.map((option) => (
              <TabsTrigger key={option} value={option} data-tab={option}>
                {INBOX_TAB_LABELS[option]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="inbox-show-resolved"
              checked={showResolved}
              onCheckedChange={(checked) => {
                setShowResolved(checked === true);
                setLimit(PAGE_SIZE);
              }}
            />
            <Label htmlFor="inbox-show-resolved" className="text-xs font-normal">
              Show resolved
            </Label>
          </div>
          {actionsEnabled ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void markAll()}
              aria-busy={markAllBusy || undefined}
              data-mark-all-read
            >
              <CheckCheck aria-hidden="true" />
              Mark all read
            </Button>
          ) : null}
        </div>
      </div>
      {markAllError ? (
        <p role="alert" className="text-xs text-danger">
          {markAllError}
        </p>
      ) : null}

      {!data ? (
        error ? (
          <EmptyState title="Could not load notifications" body={error} />
        ) : (
          <div
            className="skeleton h-40 w-full"
            aria-busy="true"
            aria-label="Loading notifications"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={empty.title}
          body={showResolved ? empty.resolvedBody : empty.body}
        />
      ) : (
        <section aria-label={INBOX_TAB_LABELS[tab]} className="grid gap-2">
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {rows.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                now={now}
                actionsEnabled={actionsEnabled}
                onMute={setMuteTarget}
              />
            ))}
          </ul>
          {data.total > rows.length ? (
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>
                Showing {rows.length} of {data.total}
              </span>
              {limit < MAX_LIMIT ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLimit((current) => Math.min(MAX_LIMIT, current + PAGE_SIZE))}
                >
                  Show more
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      <MutedGroups actionsEnabled={actionsEnabled} />
      <MuteDialog target={muteTarget} onClose={() => setMuteTarget(null)} />
    </div>
  );
}
