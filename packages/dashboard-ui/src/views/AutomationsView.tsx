import { useEffect, useState } from "react";
import { consumeSourceHealthFocus, SOURCE_HEALTH_SECTION_ID } from "@/components/overview/focus";
import { formatClock, formatIn } from "@/components/overview/overview-model";
import { Check, GitPullRequest, Play } from "lucide-react";

import { AutomationActivityStatus, visibleActivity } from "@/components/AutomationActivity";
import { AutomationGroupHeaderRow } from "@/components/AutomationGroupHeader";
import { RunResult } from "@/components/RunResult";
import { EmptyState, StatusBadge, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { triggerAutomation, usePoll } from "@/lib/api";
import type {
  AutomationSchedule,
  AutomationsResponse,
  SourceHealth,
  SourcesResponse,
} from "@/lib/api";
import { groupAutomationsByRepo, showsGroupHeaders } from "@/lib/automation-groups";
import {
  jobKind,
  jobKindLabel,
  jobTitle,
  runNowHint,
  runStartedMessage,
} from "@/lib/scheduled-jobs";
import { automationHash } from "@/lib/routes";
import { formatRunOrigin } from "@/lib/run-origin";
import {
  SOURCE_STATUS_HINTS,
  SOURCE_STATUS_TONES,
  nextRetryAt,
  providerLabel,
  sourcesNeedingAttention,
} from "@/lib/source-health";
import { cn, formatAge, formatPastTime, formatTime } from "@/lib/utils";
import { formatNextRun, humanizeSchedule } from "@/views/automation-schedule";
// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./automations.css";

function openAutomationHash(id: string): void {
  window.location.hash = automationHash(id);
}

/** Feedback strip for a manual-run trigger (mirrors the retry feedback). */
export function RunFeedback({ kind, message }: { kind: "success" | "error"; message: string }) {
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

/** One scheduled automation row with its "Run now" action. */
function AutomationRow({
  automation,
  busyId,
  startedId,
  isNext,
  onRunNow,
  onOpenRun,
  onOpenAutomation,
}: {
  automation: AutomationSchedule;
  busyId: string | null;
  startedId: string | null;
  isNext: boolean;
  onRunNow: (automation: AutomationSchedule) => void;
  onOpenRun: (id: number) => void;
  onOpenAutomation: (id: string) => void;
}) {
  const busy = busyId === automation.id;
  const started = startedId === automation.id;
  const lastRun = automation.lastRun;
  const activity = visibleActivity(automation);
  // The worker rejects a second trigger while an occurrence holds the lease.
  const inFlight = automation.activity !== undefined;
  const human = automation.schedule ? humanizeSchedule(automation.schedule) : undefined;
  const kind = jobKind(automation);
  const kindLabel = jobKindLabel(kind);
  const title = jobTitle(automation);
  return (
    <TableRow onClick={() => onOpenAutomation(automation.id)} className="auto-row cursor-pointer">
      <TableCell className="auto-cell-name max-w-xs px-4 py-2.5 font-medium md:max-w-md">
        <span className="flex items-center gap-1.5">
          <a
            href={automationHash(automation.id)}
            className="truncate hover:underline focus-visible:underline"
            title={automation.id}
            onClick={(event) => event.stopPropagation()}
          >
            {title}
          </a>
          {kindLabel ? (
            <span
              className="shrink-0 rounded-sm border border-border px-1 text-[0.6875rem] font-normal text-subtle-foreground"
              title={
                kind === "estimation"
                  ? `Story-point estimation sweep${automation.query ? ` · ${automation.query}` : ""}`
                  : kind === "auto_merge"
                    ? "Merges the agent's green pull requests when they are safe"
                    : "Scheduled conflict resolution on the agent's pull requests"
              }
            >
              {kindLabel}
            </span>
          ) : null}
          {automation.openPr ? (
            <span
              className="inline-flex shrink-0 text-subtle-foreground"
              title="Opens a pull request (open_pr = true in the config)"
            >
              <GitPullRequest className="size-3.5" aria-label="Opens a pull request" />
            </span>
          ) : null}
          {!automation.enabled ? (
            <span className="shrink-0 text-xs font-normal text-subtle-foreground">disabled</span>
          ) : null}
        </span>
      </TableCell>
      <TableCell
        className="auto-cell-schedule px-4 py-2.5 align-middle whitespace-normal"
        title={automation.schedule ? `Cron: ${automation.schedule}` : undefined}
      >
        {automation.schedule ? (
          <div className="flex flex-col">
            <span>{human ?? <code className="font-mono text-xs">{automation.schedule}</code>}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell
        className="auto-cell-next px-4 py-2.5 align-middle whitespace-nowrap"
        title={automation.nextDueAt ? formatTime(automation.nextDueAt) : undefined}
      >
        {automation.nextDueAt ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-muted-foreground">{formatNextRun(automation.nextDueAt)}</span>
            {isNext ? <StatusPill tone="info">Next</StatusPill> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell className="auto-cell-last min-w-0 px-4 py-2.5 align-middle">
        {activity ? (
          <AutomationActivityStatus activity={activity} />
        ) : lastRun ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              aria-label={`Open last run for ${title}`}
              title={`${formatRunOrigin(lastRun.origin)} · ${formatTime(lastRun.startedAt)}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenRun(lastRun.id);
              }}
            >
              <StatusBadge status={lastRun.status} />
              <span className="text-xs text-muted-foreground">
                {formatAge(lastRun.startedAt)} ago
              </span>
            </button>
            {lastRun.ticketKey || lastRun.prNumber !== undefined || lastRun.prUrl ? (
              <span className="text-xs">
                <RunResult run={lastRun} />
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell
        className="auto-cell-action px-4 py-2.5 text-right align-middle"
        onClick={(event) => event.stopPropagation()}
      >
        {automation.enabled ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || inFlight}
            aria-busy={busy || undefined}
            onClick={() => onRunNow(automation)}
            aria-label={`Run ${title} now`}
            title={inFlight ? "An occurrence is already in flight" : runNowHint(kind)}
          >
            {started ? <Check className="text-success" /> : <Play />}{" "}
            {busy ? "Starting…" : started ? "Started" : "Run now"}
          </Button>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            title="Enable this automation in the config to run it manually"
          >
            Enable in config
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Number of columns in the automations table (for full-width group rows). */
const COLUMN_COUNT = 5;

/**
 * The automations table: humanized schedule (raw cron secondary), relative
 * next run with the soonest emphasized, and a one-line last run. On narrow
 * screens each row collapses into a stacked card via `automations.css`.
 *
 * Rows are grouped by target repository (general automations first, then
 * repos by name), each group a `<tbody>` with its own header row so columns
 * stay aligned across groups. Headers show whenever any automation names a
 * repo, even a single one, so the target repo is always visible; only an
 * all-general list stays flat.
 */
export function AutomationsTable({
  automations,
  busyId,
  startedId = null,
  onRunNow,
  onOpenRun,
  onOpenAutomation = openAutomationHash,
}: {
  automations: AutomationSchedule[];
  busyId: string | null;
  startedId?: string | null;
  onRunNow: (automation: AutomationSchedule) => void;
  onOpenRun: (id: number) => void;
  onOpenAutomation?: (id: string) => void;
}) {
  const groups = groupAutomationsByRepo(automations);
  const grouped = showsGroupHeaders(groups);
  const nextId = automations
    .filter((automation) => automation.enabled && automation.nextDueAt)
    .reduce<AutomationSchedule | undefined>(
      (soonest, automation) =>
        !soonest || (automation.nextDueAt ?? Infinity) < (soonest.nextDueAt ?? Infinity)
          ? automation
          : soonest,
      undefined,
    )?.id;
  return (
    <div className="space-y-2">
      <div className="auto-table-wrap overflow-hidden rounded-lg border border-border bg-card">
        <Table className={cn("auto-table text-sm", grouped && "auto-table-grouped")}>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Automation</TableHead>
              <TableHead className="px-4">Schedule</TableHead>
              <TableHead className="px-4">Next run</TableHead>
              <TableHead className="px-4">Last run</TableHead>
              <TableHead className="px-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          {groups.map((group) => (
            <TableBody key={group.key} className="auto-group">
              {grouped ? <AutomationGroupHeaderRow group={group} colSpan={COLUMN_COUNT} /> : null}
              {group.automations.map((automation) => (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  busyId={busyId}
                  startedId={startedId}
                  isNext={automation.id === nextId}
                  onRunNow={onRunNow}
                  onOpenRun={onOpenRun}
                  onOpenAutomation={onOpenAutomation}
                />
              ))}
            </TableBody>
          ))}
        </Table>
      </div>
    </div>
  );
}

/** Muted placeholder for a value the source has never recorded. */
function Missing() {
  return <span className="text-muted-foreground">–</span>;
}

/** One source row: the exact status value, last success, and any retry window. */
function SourceHealthRow({ source, now }: { source: SourceHealth; now: number }) {
  const retryAt = nextRetryAt(source, now);
  const lastSuccessAt = typeof source.lastSuccessAt === "number" ? source.lastSuccessAt : null;
  return (
    <TableRow data-source-status={source.status}>
      <TableCell className="px-4 py-2">{providerLabel(source.provider)}</TableCell>
      <TableCell className="px-4 py-2 font-medium">{source.sourceId}</TableCell>
      <TableCell className="px-4 py-2" title={SOURCE_STATUS_HINTS[source.status]}>
        <StatusPill tone={SOURCE_STATUS_TONES[source.status]}>{source.status}</StatusPill>
      </TableCell>
      <TableCell
        className="px-4 py-2 whitespace-nowrap"
        title={lastSuccessAt !== null ? formatTime(lastSuccessAt) : undefined}
      >
        {lastSuccessAt !== null ? formatPastTime(lastSuccessAt, now) : <Missing />}
      </TableCell>
      <TableCell className="px-4 py-2 tabular-nums">{source.consecutiveFailures}</TableCell>
      <TableCell
        className="max-w-sm truncate px-4 py-2 text-muted-foreground"
        title={source.message ?? undefined}
      >
        {source.message ? source.message : <Missing />}
      </TableCell>
      <TableCell
        className="px-4 py-2 whitespace-nowrap"
        title={retryAt !== null ? formatTime(retryAt) : undefined}
      >
        {retryAt !== null ? (
          <span data-next-retry={retryAt}>
            {formatClock(retryAt, now)}{" "}
            <span className="text-muted-foreground">({formatIn(retryAt, now)})</span>
          </span>
        ) : (
          <Missing />
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Source health for automation sources (error monitors today), listed only
 * for sources in the current config. Hidden when none is configured. While
 * every source reads normally it collapses to one muted line, so a healthy
 * worker never carries a permanent success table; any failing source expands
 * it into a compact table of every source.
 */
export function SourceHealthSection({
  sources,
  now = Date.now(),
}: {
  sources: readonly SourceHealth[];
  now?: number;
}) {
  useEffect(() => {
    consumeSourceHealthFocus();
  }, []);
  if (sources.length === 0) return null;
  const unhealthy = sourcesNeedingAttention(sources);
  if (unhealthy.length === 0) {
    return (
      <p
        id={SOURCE_HEALTH_SECTION_ID}
        tabIndex={-1}
        className="ov-focus-target rounded-lg text-sm text-muted-foreground"
        data-source-health="healthy"
      >
        Source health: {sources.length === 1 ? "1 source" : `${sources.length} sources`} reading
        normally.
      </p>
    );
  }
  return (
    <section
      id={SOURCE_HEALTH_SECTION_ID}
      tabIndex={-1}
      aria-labelledby="source-health-heading"
      className="ov-focus-target space-y-2 rounded-lg"
      data-source-health="attention"
    >
      <h2 id="source-health-heading" className="text-sm font-semibold">
        Source health
      </h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Provider</TableHead>
              <TableHead className="px-4">Source</TableHead>
              <TableHead className="px-4">Status</TableHead>
              <TableHead className="px-4">Last success</TableHead>
              <TableHead className="px-4">Failures</TableHead>
              <TableHead className="px-4">Message</TableHead>
              <TableHead className="px-4">Next retry</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => (
              <SourceHealthRow
                key={`${source.provider}:${source.sourceId}`}
                source={source}
                now={now}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** Source health fed by its own poll, so a failing read never blocks automations. */
function SourceHealthPanel() {
  const { data } = usePoll<SourcesResponse>("/api/sources");
  return data ? <SourceHealthSection sources={data.sources ?? []} /> : null;
}

/** "Run now" trigger state shared by the list and detail pages. */
export function useRunNow(refresh: () => void) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );

  useEffect(() => {
    if (!startedId) return;
    const timer = window.setTimeout(() => setStartedId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [startedId]);

  async function runNow(automation: AutomationSchedule) {
    setBusyId(automation.id);
    setFeedback(null);
    setStartedId(null);
    try {
      const { ok, body } = await triggerAutomation(automation.id);
      if (ok) {
        setStartedId(automation.id);
        setFeedback({ kind: "success", message: runStartedMessage(automation) });
        refresh();
      } else {
        setFeedback({
          kind: "error",
          message: body.error ?? `Could not trigger ${jobTitle(automation)}.`,
        });
      }
    } catch (cause: unknown) {
      setFeedback({
        kind: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusyId(null);
    }
  }

  return { busyId, startedId, feedback, runNow };
}

/**
 * Scheduled jobs — prompt automations, estimation sweeps, and the scheduled
 * conflict-resolution window — each with an on-demand "Run now"; open one for
 * its prompt (or query) and recent runs.
 */
export function AutomationsView({ onOpenRun }: { onOpenRun: (id: number) => void }) {
  const { data, error, refresh } = usePoll<AutomationsResponse>("/api/automations");
  const { busyId, startedId, feedback, runNow } = useRunNow(refresh);

  return (
    <div className="space-y-4">
      {feedback ? <RunFeedback {...feedback} /> : null}

      <SourceHealthPanel />

      {error ? <EmptyState title="Could not load automations" body={error} /> : null}

      {data && data.automations.length === 0 ? (
        <EmptyState
          title="No scheduled jobs configured"
          body='Add [[automations]] entries (a schedule plus a prompt) or [[estimations]] sweeps to workspace.toml — or .devintern-code/automations.toml for a single repo — or set conflict_resolution = "scheduled". The worker reloads workspace changes automatically; "Run now" then appears here for instant validation.'
        />
      ) : null}

      {data && data.automations.length > 0 ? (
        <AutomationsTable
          automations={data.automations}
          busyId={busyId}
          startedId={startedId}
          onRunNow={(target) => void runNow(target)}
          onOpenRun={onOpenRun}
        />
      ) : null}
    </div>
  );
}
