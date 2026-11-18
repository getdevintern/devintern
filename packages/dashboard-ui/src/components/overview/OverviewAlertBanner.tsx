import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Check,
  CirclePause,
  Copy,
  FileWarning,
  FileX,
  PowerOff,
  RadioTower,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revealElement } from "@/components/overview/focus";
import {
  formatAgo,
  formatClock,
  formatIn,
  formatInterval,
} from "@/components/overview/overview-model";
import type { OverviewAlert } from "@/components/overview/overview-model";
import { cn } from "@/lib/utils";
import { trackerRowId, sourceName } from "@/components/overview/TrackerSection";

const ALERT_TONES = {
  danger: {
    box: "border-danger-border bg-danger-subtle",
    icon: "bg-danger/15 text-danger",
    text: "text-[color-mix(in_srgb,var(--foreground)_82%,var(--danger))]",
  },
  warning: {
    box: "border-warning-border bg-warning-subtle",
    icon: "bg-warning/15 text-warning",
    text: "text-[color-mix(in_srgb,var(--foreground)_82%,var(--warning))]",
  },
} as const;

function AlertBanner({
  tone,
  icon: Icon,
  title,
  children,
  aside,
  action,
  prominent = false,
}: {
  tone: "danger" | "warning";
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode;
  prominent?: boolean;
}) {
  const colors = ALERT_TONES[tone];
  return (
    <div
      data-slot="overview-alert"
      data-tone={tone}
      data-prominent={prominent ? "" : undefined}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2 rounded-lg border sm:grid-cols-[auto_minmax(0,1fr)_auto]",
        prominent ? "items-center px-5 py-4" : "items-start px-4 py-3.5",
        colors.box,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid place-items-center",
          prominent ? "size-10 rounded-[10px]" : "size-7 rounded-md",
          colors.icon,
        )}
      >
        <Icon className={prominent ? "size-5" : "size-4"} />
      </span>
      <div className={cn("min-w-0", !prominent && "pt-0.5")}>
        <p
          className={cn(
            "font-semibold text-foreground",
            prominent ? "text-base tracking-[-0.01em]" : "text-sm",
          )}
        >
          {title}
        </p>
        {children ? (
          <div className={cn("mt-0.5 max-w-[75ch] text-[0.8125rem] leading-relaxed", colors.text)}>
            {children}
          </div>
        ) : null}
      </div>
      {aside ?? null}
      {action ? <div className="col-start-2 self-center sm:col-start-auto">{action}</div> : null}
    </div>
  );
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href}>
        {children}
        <ArrowRight aria-hidden="true" />
      </a>
    </Button>
  );
}

function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      title={command}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => setCopied(true));
      }}
    >
      {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Copied" : "Copy command"}</span>
    </Button>
  );
}

function Code({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  return (
    <code
      className={cn(
        "rounded bg-background/55 px-1 py-px font-mono text-xs text-foreground",
        wrap ? "[overflow-wrap:anywhere]" : "whitespace-nowrap",
      )}
    >
      {children}
    </code>
  );
}

/** One banner per degraded state; exported for tests. */
export function OverviewAlertBanner({
  alert,
  now,
  pollIntervalSeconds,
  queued,
}: {
  alert: OverviewAlert;
  now: number;
  pollIntervalSeconds?: number;
  /** Total queued work, when known (from `/api/worker`). */
  queued?: number;
}) {
  switch (alert.kind) {
    case "config-missing":
      return (
        <AlertBanner
          tone="warning"
          icon={FileX}
          title="No workspace configuration"
          action={<CopyCommandButton command="devintern worker init" />}
        >
          Nothing exists at <Code wrap>{alert.path}</Code>. Run <Code>devintern worker init</Code>{" "}
          to create it; capacity limits and tracker sources appear here once it loads.
        </AlertBanner>
      );
    case "config-invalid":
      return (
        <AlertBanner
          tone="danger"
          icon={FileWarning}
          title="workspace.toml could not be loaded"
          action={<LinkButton href="#/workspace">Open workspace</LinkButton>}
        >
          <p>
            Fix <Code wrap>{alert.path}</Code>. A running worker keeps its last valid configuration
            until the file loads again.
          </p>
          {alert.error ? (
            <pre className="mt-2 overflow-x-auto rounded-md border border-danger-border bg-background/70 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-foreground">
              {alert.error}
            </pre>
          ) : null}
        </AlertBanner>
      );
    case "worker-stopped":
      return (
        <AlertBanner
          tone="danger"
          icon={PowerOff}
          title="Worker is not running"
          action={<LinkButton href="#/logs">Open worker logs</LinkButton>}
        >
          New tickets are not being picked up
          {alert.pid !== undefined ? ` (the lock left by pid ${alert.pid} is stale)` : ""}. Start it
          with <Code>devintern worker</Code>, or restart its service.
        </AlertBanner>
      );
    case "harnesses-exhausted": {
      const waiting =
        queued !== undefined && queued > 0
          ? `${queued} queued ${queued === 1 ? "task waits" : "tasks wait"}`
          : "New agent work waits";
      return (
        <AlertBanner
          tone="warning"
          icon={CirclePause}
          prominent
          title={
            alert.resumesAt !== undefined
              ? `Agent work is paused until ${formatClock(alert.resumesAt, now)}`
              : "Agent work is paused"
          }
          aside={
            alert.resumesAt !== undefined ? (
              <div className="col-start-2 flex flex-col sm:col-start-auto sm:items-end sm:border-l sm:border-warning-border sm:pl-5 sm:text-right">
                <span className="text-2xl leading-tight font-semibold tracking-[-0.02em] whitespace-nowrap text-warning tabular-nums">
                  {formatIn(alert.resumesAt, now)}
                </span>
                <span className="text-xs whitespace-nowrap text-[color-mix(in_srgb,var(--foreground)_70%,var(--warning))]">
                  resumes automatically
                </span>
              </div>
            ) : undefined
          }
        >
          Every harness in the chain has hit its usage limit. {waiting}
          {alert.resumesWith ? (
            <>
              {" "}
              and the worker resumes with{" "}
              <strong className="text-foreground">{alert.resumesWith}</strong> when its window ends.
            </>
          ) : (
            " until a window ends."
          )}
        </AlertBanner>
      );
    }
    case "stale-polls": {
      const interval = formatInterval(pollIntervalSeconds ?? 60);
      const [first] = alert.sources;
      return (
        <AlertBanner
          tone="warning"
          icon={RadioTower}
          title={
            alert.sources.length === 1
              ? "Tracker polling has stalled"
              : `Tracker polling has stalled for ${alert.sources.length} sources`
          }
          action={<LinkButton href="#/logs">Check worker logs</LinkButton>}
        >
          {alert.sources.map((source, index) => (
            <span key={source.cursorSource}>
              {index > 0 ? ", " : ""}
              <button
                type="button"
                className="rounded-sm font-semibold text-foreground underline decoration-dotted underline-offset-3 hover:decoration-solid"
                onClick={() => revealElement(trackerRowId(source))}
              >
                {sourceName(source)}
              </button>
            </span>
          ))}
          {alert.sources.length === 1 && first?.lastPolledAt !== undefined
            ? ` last polled ${formatAgo(first.lastPolledAt, now)}; polls are expected ${interval}.`
            : ` have not polled on schedule; polls are expected ${interval}.`}{" "}
          Tracker credentials or network errors usually show up in the worker logs.
        </AlertBanner>
      );
    }
  }
}

/* ---------- Worker facts ---------- */
