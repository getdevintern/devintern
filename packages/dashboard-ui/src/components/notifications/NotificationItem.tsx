import { useState } from "react";
import { BellOff, Check, ChevronDown, CircleCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePoll } from "@/lib/api";
import type { RunDetailResponse } from "@/lib/api";
import { isUnread, markNotificationRead, resolveNotification } from "@/lib/api-notifications";
import type { NotificationActionResult, NotificationRecord } from "@/lib/api-notifications";
import { cn } from "@/lib/utils";
import { SpawnedWorkSection } from "@/views/run-detail/Lineage";
import { KIND_META } from "./kind-meta";
import {
  GroupCount,
  KindIcon,
  NotificationAge,
  NotificationLinks,
  UnreadMarker,
} from "./NotificationParts";
// oxlint-disable-next-line import/no-unassigned-import -- bell bubble and unread row styles
import "./notifications.css";

/**
 * Children of a `work_spawned` row with their live status, from the parent
 * run's lineage (the same data the run detail page's "Spawned work" shows).
 */
export function SpawnedWorkLive({ runId, idPrefix }: { runId: number; idPrefix: string }) {
  const { data, error } = usePoll<RunDetailResponse>(`/api/runs/${runId}`);
  if (error && !data) {
    return <p className="text-xs text-danger">Could not load spawned work: {error}</p>;
  }
  if (!data) {
    return <p className="text-xs text-muted-foreground">Loading spawned work…</p>;
  }
  const spawned = data.lineage?.spawned ?? [];
  if (spawned.length === 0) {
    return <p className="text-xs text-muted-foreground">No spawned work recorded for this run.</p>;
  }
  return (
    <SpawnedWorkSection
      spawned={spawned}
      idPrefix={idPrefix}
      className="rounded-md border border-border bg-raised px-3 py-3"
    />
  );
}

/** One inbox row: what happened, where, when, and what to do about it. */
export function NotificationItem({
  notification,
  now,
  actionsEnabled,
  onMute,
}: {
  notification: NotificationRecord;
  now: number;
  /** False in the read-only demo. */
  actionsEnabled: boolean;
  /** Ask to mute this row's group (the inbox confirms first). */
  onMute: (notification: NotificationRecord) => void;
}) {
  const [busy, setBusy] = useState<"read" | "resolve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const unread = isUnread(notification);
  const resolved = notification.resolvedAt !== undefined;
  const titleId = `notification-${notification.id}-title`;
  const spawnedId = `notification-${notification.id}-spawned`;
  const spawnRunId = notification.kind === "work_spawned" ? notification.runId : undefined;
  const canExpand = spawnRunId !== undefined;

  const run = async (
    action: "read" | "resolve",
    call: (id: number) => Promise<NotificationActionResult>,
  ) => {
    setBusy(action);
    setError(null);
    const result = await call(notification.id);
    setBusy(null);
    if (!result.ok) setError(result.error);
  };

  return (
    <li
      aria-labelledby={titleId}
      data-notification-id={notification.id}
      data-unread={unread ? "true" : undefined}
      className={cn(
        "notification-item grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3",
        unread && "notification-item-unread",
        resolved && "opacity-75",
      )}
    >
      <KindIcon kind={notification.kind} />
      <div className="grid min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {unread ? <UnreadMarker /> : null}
          <span
            id={titleId}
            className={cn("min-w-0 text-[0.8125rem]", unread ? "font-semibold" : "font-medium")}
          >
            {notification.title}
          </span>
          <GroupCount count={notification.count} />
          {resolved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <CircleCheck className="size-3" aria-hidden="true" />
              Resolved
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
          <span>{KIND_META[notification.kind].label}</span>
          {notification.repo ? <span className="font-mono">{notification.repo}</span> : null}
          <NotificationAge at={notification.updatedAt} now={now} />
        </div>
        {notification.body ? (
          <p className="text-xs whitespace-pre-line text-muted-foreground">{notification.body}</p>
        ) : null}
        <NotificationLinks notification={notification} max={canExpand ? 3 : undefined} />

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {canExpand ? (
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={expanded}
              aria-controls={spawnedId}
              onClick={() => setExpanded((open) => !open)}
            >
              <ChevronDown
                className={cn("transition-transform", expanded && "rotate-180")}
                aria-hidden="true"
              />
              {expanded ? "Hide spawned work" : "Show spawned work"}
            </Button>
          ) : null}
          {actionsEnabled && unread ? (
            <Button
              variant="ghost"
              size="xs"
              aria-busy={busy === "read" || undefined}
              disabled={busy !== null}
              onClick={() => void run("read", markNotificationRead)}
              aria-label={`Mark read: ${notification.title}`}
            >
              <Check aria-hidden="true" />
              Mark read
            </Button>
          ) : null}
          {actionsEnabled && !resolved ? (
            <Button
              variant="ghost"
              size="xs"
              aria-busy={busy === "resolve" || undefined}
              disabled={busy !== null}
              onClick={() => void run("resolve", resolveNotification)}
              aria-label={`Resolve: ${notification.title}`}
            >
              <CircleCheck aria-hidden="true" />
              Resolve
            </Button>
          ) : null}
          {actionsEnabled ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy !== null}
              onClick={() => onMute(notification)}
              aria-label={`Mute this group: ${notification.title}`}
            >
              <BellOff aria-hidden="true" />
              Mute
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        {spawnRunId !== undefined ? (
          <div id={spawnedId} hidden={!expanded}>
            {expanded ? (
              <SpawnedWorkLive runId={spawnRunId} idPrefix={`notification-${notification.id}`} />
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
