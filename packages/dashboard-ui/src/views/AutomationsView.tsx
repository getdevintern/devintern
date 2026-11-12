import { useEffect, useState } from "react";
import { Check, GitPullRequest, Play } from "lucide-react";

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
import type { AutomationSchedule, AutomationsResponse } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { cn, formatAge, formatTime } from "@/lib/utils";
import { formatNextRun, humanizeSchedule } from "@/views/automation-schedule";
// oxlint-disable-next-line import/no-unassigned-import -- view styles
import "./automations.css";

/** Hash route of one automation's detail page. */
export function automationHash(id: string): string {
  return `#/automations/${encodeURIComponent(id)}`;
}

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
  showRepo,
  isNext,
  onRunNow,
  onOpenRun,
  onOpenAutomation,
}: {
  automation: AutomationSchedule;
  busyId: string | null;
  startedId: string | null;
  showRepo: boolean;
  isNext: boolean;
  onRunNow: (automation: AutomationSchedule) => void;
  onOpenRun: (id: number) => void;
  onOpenAutomation: (id: string) => void;
}) {
  const busy = busyId === automation.id;
  const started = startedId === automation.id;
  const lastRun = automation.lastRun;
  const human = automation.schedule ? humanizeSchedule(automation.schedule) : undefined;
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
            {automation.id}
          </a>
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
        className="auto-cell-schedule px-4 py-2.5 align-middle"
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
      {showRepo ? (
        <TableCell
          className="auto-cell-repo hidden max-w-32 truncate px-4 py-2.5 align-middle text-xs text-subtle-foreground lg:table-cell"
          title={automation.repo}
        >
          {automation.repo ?? "–"}
        </TableCell>
      ) : null}
      <TableCell className="auto-cell-last min-w-0 px-4 py-2.5 align-middle">
        {lastRun ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              aria-label={`Open last run for ${automation.id}`}
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
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => onRunNow(automation)}
            aria-label={`Run ${automation.id} now`}
            title="Runs through the same pipeline as a scheduled run and is recorded with the manual origin"
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

/**
 * The automations table: humanized schedule (raw cron secondary), relative
 * next run with the soonest emphasized, and a one-line last run. On narrow
 * screens each row collapses into a stacked card via `automations.css`. The
 * repo column is dropped when every automation targets the same repository.
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
  const repos = new Set(automations.map((automation) => automation.repo));
  const showRepo = repos.size > 1;
  const sorted = [...automations].sort(
    (a, b) =>
      (a.enabled ? 0 : 1) - (b.enabled ? 0 : 1) ||
      (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity),
  );
  const nextId = sorted.find((automation) => automation.enabled && automation.nextDueAt)?.id;
  const commonRepo = !showRepo ? automations[0]?.repo : undefined;
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <Table className="auto-table text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Automation</TableHead>
              <TableHead className="px-4">Schedule</TableHead>
              <TableHead className="px-4">Next run</TableHead>
              {showRepo ? <TableHead className="hidden px-4 lg:table-cell">Repo</TableHead> : null}
              <TableHead className="px-4">Last run</TableHead>
              <TableHead className="px-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                busyId={busyId}
                startedId={startedId}
                showRepo={showRepo}
                isNext={automation.id === nextId}
                onRunNow={onRunNow}
                onOpenRun={onOpenRun}
                onOpenAutomation={onOpenAutomation}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {commonRepo ? (
        <p className="text-xs text-subtle-foreground">
          All automations run in <span className="font-mono">{commonRepo}</span>
        </p>
      ) : null}
    </div>
  );
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
        setFeedback({
          kind: "success",
          message: `Manual run of ${automation.id} started. It will appear in the run list with origin "Manual run" shortly.`,
        });
        refresh();
      } else {
        setFeedback({
          kind: "error",
          message: body.error ?? `Could not trigger ${automation.id}.`,
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

/** Scheduled automations; open one for its prompt and recent runs. */
export function AutomationsView({ onOpenRun }: { onOpenRun: (id: number) => void }) {
  const { data, error, refresh } = usePoll<AutomationsResponse>("/api/automations");
  const { busyId, startedId, feedback, runNow } = useRunNow(refresh);

  return (
    <div className="space-y-4">
      {feedback ? <RunFeedback {...feedback} /> : null}

      {error ? <EmptyState title="Could not load automations" body={error} /> : null}

      {data && data.automations.length === 0 ? (
        <EmptyState
          title="No automations configured"
          body='Add [[automations]] entries (a schedule plus a prompt) to workspace.toml — or .devintern-code/automations.toml for a single repo. The worker reloads workspace changes automatically; "Run now" then appears here for instant validation.'
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
