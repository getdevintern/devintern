import { useState } from "react";
import { ArrowLeft, Check, Copy, GitPullRequest, Play, RefreshCcw } from "lucide-react";

import {
  AutomationActivityStatus,
  AutomationDeferralStatus,
  visibleActivity,
} from "@/components/AutomationActivity";
import { RunResult } from "@/components/RunResult";
import { EmptyState, StatusBadge, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { runMatchesFilter, scheduledJobRunsUrl, usePoll } from "@/lib/api";
import type { AutomationSchedule, AutomationsResponse, RunRecord, RunsResponse } from "@/lib/api";
import { isDemoMode } from "@/lib/demo";
import { Markdown } from "@/lib/markdown";
import { formatRunOrigin } from "@/lib/run-origin";
import {
  jobKind,
  jobKindLabel,
  jobTitle,
  runFilterForJobId,
  runNowHint,
} from "@/lib/scheduled-jobs";
import { cn, formatAge, formatDuration, formatTime } from "@/lib/utils";
import { formatNextRun, humanizeSchedule } from "@/views/automation-schedule";
import { RunFeedback, useRunNow } from "@/views/AutomationsView";

const RECENT_RUNS = 10;
/** Runs shown before "Show all" on narrow screens. */
const COLLAPSED_RUNS = 5;
/** Over-fetch so client-side filtering stays correct against servers that ignore the run filter. */
const FETCH_RUNS = 100;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 lg:flex lg:items-baseline lg:justify-between lg:gap-4">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-[0.8125rem] break-words lg:mt-0 lg:text-right">
        {children}
      </dd>
    </div>
  );
}

function CopyPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context): the prompt stays selectable.
    }
  }
  return (
    <Button variant="ghost" size="xs" onClick={() => void copy()} aria-label="Copy prompt">
      {copied ? <Check className="text-success" /> : <Copy />} {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** Compact recent-run list for the rail; collapsed to a few items on narrow screens. */
function RecentRuns({
  runs,
  loading,
  error,
}: {
  runs: RunRecord[];
  loading: boolean;
  error: string | null;
}) {
  const [showAllRuns, setShowAllRuns] = useState(false);
  return (
    <section aria-labelledby="ad-runs" className="mt-6 space-y-2">
      <h3 id="ad-runs" className="section-title">
        Recent runs
      </h3>
      {error ? (
        <p className="text-sm text-danger">Could not load runs. {error}</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {loading ? "Loading runs…" : "No runs recorded yet."}
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {runs.map((run, index) => (
              <a
                key={run.id}
                href={`#/runs/${run.id}`}
                className={cn(
                  "ad-run text-[0.8125rem]",
                  index >= COLLAPSED_RUNS && !showAllRuns && "ad-run-extra",
                )}
                aria-label={`Open run #${run.id}`}
              >
                <span className="ad-run-badge">
                  <StatusBadge status={run.status} />
                </span>
                <span className="tabular flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span title={formatTime(run.startedAt)}>{formatAge(run.startedAt)} ago</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : "running"}
                  </span>
                  {run.origin === "manual" ? (
                    <span className="rounded-sm border border-border px-1 text-[0.6875rem] text-subtle-foreground">
                      {formatRunOrigin(run.origin)}
                    </span>
                  ) : null}
                </span>
                {run.outcomeReason || run.prNumber !== undefined || run.prUrl ? (
                  <span
                    className="ad-run-detail min-w-0 truncate text-xs text-muted-foreground"
                    title={run.outcomeReason}
                  >
                    {run.prNumber !== undefined || run.prUrl ? (
                      <span className="mr-2">
                        <RunResult run={run} />
                      </span>
                    ) : null}
                    {run.outcomeReason}
                  </span>
                ) : null}
              </a>
            ))}
          </div>
          {runs.length > COLLAPSED_RUNS ? (
            <Button
              variant="ghost"
              size="xs"
              className="ad-run-toggle"
              onClick={() => setShowAllRuns((value) => !value)}
            >
              {showAllRuns ? "Show fewer" : `Show all ${runs.length}`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Facts rail: schedule, next run, target, agent, and last run. */
function JobFacts({ automation }: { automation: AutomationSchedule }) {
  const human = automation.schedule ? humanizeSchedule(automation.schedule) : undefined;
  const lastRun = automation.lastRun;
  const activity = visibleActivity(automation);
  const kind = jobKind(automation);
  const title = jobTitle(automation);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-1 lg:gap-y-2.5">
      <Fact label="Schedule">
        {automation.schedule ? (
          <>
            {human ?? <code className="font-mono text-xs">{automation.schedule}</code>}
            {human ? (
              <code className="block font-mono text-xs text-subtle-foreground">
                {automation.schedule}
              </code>
            ) : null}
          </>
        ) : (
          "–"
        )}
      </Fact>
      <Fact label="Next run">
        {automation.nextDueAt ? (
          <>
            {formatNextRun(automation.nextDueAt)}
            <span className="tabular block text-xs text-subtle-foreground">
              {formatTime(automation.nextDueAt)}
            </span>
          </>
        ) : (
          "–"
        )}
      </Fact>
      {kind === "automation" ? <Fact label="Repository">{automation.repo ?? "–"}</Fact> : null}
      {kind === "estimation" ? (
        <Fact label="Team">
          {automation.team ?? <span className="text-muted-foreground">Default tracker</span>}
        </Fact>
      ) : null}
      <Fact label="Agent">
        {automation.harness ?? <span className="text-muted-foreground">Workspace default</span>}
      </Fact>
      <Fact label="Model">
        {automation.model ? (
          <code className="font-mono text-xs">{automation.model}</code>
        ) : (
          <span className="text-muted-foreground">Harness default</span>
        )}
      </Fact>
      <Fact label="Effort">
        {automation.effort ?? <span className="text-muted-foreground">Harness default</span>}
      </Fact>
      {kind === "automation" ? (
        <Fact label="Opens PR">
          {automation.openPr ? (
            <span className="inline-flex items-center gap-1">
              <GitPullRequest className="size-3.5" aria-hidden="true" /> Yes
            </span>
          ) : (
            <span className="text-muted-foreground">No</span>
          )}
        </Fact>
      ) : null}
      {activity ? (
        <Fact label="Now">
          <AutomationActivityStatus activity={activity} />
          {activity.state === "waiting" && activity.reason ? (
            <span className="block text-xs text-subtle-foreground">
              {activity.reason.charAt(0).toUpperCase() + activity.reason.slice(1)}
            </span>
          ) : null}
        </Fact>
      ) : automation.deferral ? (
        <Fact label="Now">
          <AutomationDeferralStatus deferral={automation.deferral} />
        </Fact>
      ) : null}
      <Fact label="Last run">
        {lastRun ? (
          <a
            href={`#/runs/${lastRun.id}`}
            className="inline-flex items-center gap-2"
            aria-label={`Open last run for ${title}`}
          >
            <StatusBadge status={lastRun.status} />
            <span className="text-xs text-muted-foreground">
              {formatAge(lastRun.startedAt)} ago
            </span>
          </a>
        ) : (
          "–"
        )}
      </Fact>
    </dl>
  );
}

/** Main content: the prompt, the estimation query, or the conflict-window description. */
function JobBody({ automation }: { automation: AutomationSchedule }) {
  const kind = jobKind(automation);
  const prompt = automation.prompt.trim();
  if (kind === "estimation") {
    return (
      <>
        <div className="flex max-w-[72ch] items-center gap-2">
          <h3 id="ad-prompt" className="section-title">
            Query
          </h3>
          {automation.query ? <CopyPromptButton text={automation.query} /> : null}
        </div>
        <pre className="max-w-[72ch] overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {automation.query ?? "–"}
        </pre>
        <p className="max-w-[72ch] text-sm text-muted-foreground">
          Each sweep estimates story points for the tickets this query selects. Tickets estimated
          less than a day ago, or unchanged since their last estimate, are skipped. No branches or
          pull requests are created.
        </p>
      </>
    );
  }
  return (
    <>
      <div className="flex max-w-[72ch] items-center gap-2">
        <h3 id="ad-prompt" className="section-title">
          {kind === "automation" ? "Prompt" : "About"}
        </h3>
        {kind === "automation" ? <CopyPromptButton text={prompt} /> : null}
      </div>
      <div className="max-w-[72ch]">
        <Markdown>{prompt}</Markdown>
      </div>
    </>
  );
}

/**
 * One scheduled job: prompt (automation), query (estimation sweep), or a
 * description (conflict window) as the main content, a facts rail, and its
 * recent runs.
 */
export function AutomationDetailView({ automationId }: { automationId: string }) {
  const { data, error, loading, refresh } = usePoll<AutomationsResponse>("/api/automations");
  const automation = data?.automations.find((candidate) => candidate.id === automationId);
  const runFilter = automation?.runFilter ?? runFilterForJobId(automationId);
  const runsState = usePoll<RunsResponse>(scheduledJobRunsUrl(runFilter, FETCH_RUNS));
  const { busyId, startedId, feedback, runNow } = useRunNow(() => {
    refresh();
    runsState.refresh();
  });

  const runs = (runsState.data?.runs ?? [])
    .filter((run) => runMatchesFilter(run, runFilter))
    .slice(0, RECENT_RUNS);

  if (!data && loading) {
    return (
      <div role="status" aria-label="Loading automation" className="space-y-3 py-2">
        <div className="skeleton h-7 w-64" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="space-y-3">
        <EmptyState title="Could not load automation" body={error} />
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCcw /> Try again
        </Button>
      </div>
    );
  }
  if (!automation) {
    return (
      <div className="space-y-3">
        <EmptyState
          title="Automation not found"
          body={`No automation with id "${automationId}" is configured.`}
        />
        <Button variant="outline" size="sm" asChild>
          <a href="#/automations">
            <ArrowLeft /> Back to automations
          </a>
        </Button>
      </div>
    );
  }

  const busy = busyId === automation.id;
  const started = startedId === automation.id;
  const kind = jobKind(automation);
  const kindLabel = jobKindLabel(kind);
  const title = jobTitle(automation);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="min-w-0 text-lg font-semibold break-words" title={automation.id}>
          {title}
        </h2>
        {kindLabel ? <StatusPill tone="info">{kindLabel}</StatusPill> : null}
        <StatusPill tone={automation.enabled ? "success" : "neutral"}>
          {automation.enabled ? "Enabled" : "Disabled"}
        </StatusPill>
        <div className="toolbar-spacer" />
        {isDemoMode() ? null : automation.enabled ? (
          <Button
            size="sm"
            disabled={busy || automation.activity !== undefined}
            aria-busy={busy || undefined}
            onClick={() => void runNow(automation)}
            title={
              automation.activity !== undefined
                ? "An occurrence is already in flight"
                : runNowHint(kind)
            }
          >
            {started ? <Check /> : <Play />} {busy ? "Starting…" : started ? "Started" : "Run now"}
          </Button>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            title="Enable this automation in the config to run it manually"
          >
            Enable in config to run manually
          </span>
        )}
      </header>

      {feedback ? <RunFeedback {...feedback} /> : null}

      <div className="ad-grid">
        <aside aria-label="Automation facts" className="ad-rail">
          <JobFacts automation={automation} />
          <RecentRuns
            runs={runs}
            loading={runsState.loading}
            error={runsState.data ? null : runsState.error}
          />
        </aside>
        <section aria-labelledby="ad-prompt" className="ad-main min-w-0 space-y-3">
          <JobBody automation={automation} />
        </section>
      </div>
    </div>
  );
}
