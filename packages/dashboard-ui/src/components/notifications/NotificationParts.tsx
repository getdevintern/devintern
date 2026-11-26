/** Building blocks shared by the bell popover, the inbox rows, and the overview block. */

import { ExternalLink } from "lucide-react";

import { groupCountLabel } from "@/lib/api-notifications";
import type {
  NotificationKind,
  NotificationLink,
  NotificationRecord,
} from "@/lib/api-notifications";
import { runHash } from "@/lib/routes";
import { cn, formatAge, formatTime } from "@/lib/utils";
import { safeHref } from "@/views/run-detail/lineage-labels";
import { KIND_META, TONE_ICON_CLASS } from "./kind-meta";

/** Kind icon in a tinted square; the kind name is its accessible label. */
export function KindIcon({ kind, size = "md" }: { kind: NotificationKind; size?: "sm" | "md" }) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  return (
    <span
      role="img"
      aria-label={meta.label}
      title={meta.label}
      className={cn(
        "grid shrink-0 place-items-center rounded-md border",
        size === "sm" ? "size-6" : "size-8",
        TONE_ICON_CLASS[meta.tone],
      )}
    >
      <Icon className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden="true" />
    </span>
  );
}

/** "×88" badge for a grouped row; nothing for a single event. */
export function GroupCount({ count }: { count: number }) {
  const label = groupCountLabel(count);
  if (!label) return null;
  return (
    <span
      data-slot="notification-count"
      className="tabular inline-flex h-5 shrink-0 items-center rounded-full border border-border-strong bg-raised px-1.5 text-[0.6875rem] font-semibold text-foreground"
      title={`Happened ${count} times`}
    >
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{`${count} occurrences`}</span>
    </span>
  );
}

/**
 * Unread marker: a dot plus the word "New", so unread is not conveyed by
 * color alone.
 */
export function UnreadMarker() {
  return (
    <span
      data-slot="notification-unread"
      className="inline-flex shrink-0 items-center gap-1 text-[0.6875rem] font-semibold tracking-wide text-primary uppercase"
    >
      <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
      New
    </span>
  );
}

/** Relative time of the latest event ("5m ago"), with the absolute time on hover. */
export function NotificationAge({ at, now }: { at: number; now: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={formatTime(at)}
      className="tabular shrink-0 text-xs text-subtle-foreground"
    >
      {formatAge(at, now)} ago
    </time>
  );
}

function LinkItem({ link }: { link: NotificationLink }) {
  const href = safeHref(link.url);
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="ref-link">
        {link.label}
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
    );
  }
  if (link.runId !== undefined) {
    return (
      <a href={runHash(link.runId)} className="ref-link">
        {link.label}
      </a>
    );
  }
  return <span className="text-muted-foreground">{link.label}</span>;
}

/** Links to the run, PR, ticket, or tasks a notification is about. */
export function NotificationLinks({
  notification,
  max,
}: {
  notification: NotificationRecord;
  /** Show at most this many (the rest are summarized). */
  max?: number;
}) {
  const links = notification.links;
  if (links.length === 0) return null;
  const shown = max !== undefined ? links.slice(0, max) : links;
  const hidden = links.length - shown.length;
  return (
    <ul
      aria-label="Links"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
      data-slot="notification-links"
    >
      {shown.map((link, index) => (
        <li key={`${link.label}-${link.url ?? link.runId ?? link.taskKey ?? index}`}>
          <LinkItem link={link} />
        </li>
      ))}
      {hidden > 0 ? <li className="text-subtle-foreground">+{hidden} more</li> : null}
    </ul>
  );
}
