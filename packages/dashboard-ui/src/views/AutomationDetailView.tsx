import { useState } from "react";
import { ArrowLeft, Check, Copy, GitPullRequest, Play, RefreshCcw } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, StatusBadge, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { automationRunsUrl, usePoll } from "@/lib/api";
import type { AutomationsResponse, RunRecord, RunsResponse } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { formatRunOrigin } from "@/lib/run-origin";
import { cn, formatAge, formatDuration, formatTime } from "@/lib/utils";
import { formatNextRun, humanizeSchedule } from "@/views/automation-schedule";
import { RunFeedback, useRunNow } from "@/views/AutomationsView";

const RECENT_RUNS = 10;
/** Runs shown before "Show all" on narrow screens. */
const COLLAPSED_RUNS = 5;
/** Over-fetch so client-side filtering stays correct against servers that ignore `automationId`. */
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

/** One automation: prompt as the main content, facts rail, and its recent runs. */
export function AutomationDetailView({ automationId }: { automationId: string }) {
  const { data, error, loading, refresh } = usePoll<AutomationsResponse>("/api/automations");
  const runsState = usePoll<RunsResponse>(automationRunsUrl(automationId, FETCH_RUNS));
  const { busyId, startedId, feedback, runNow } = useRunNow(() => {
    refresh();
    runsState.refresh();
  });

  const automation = data?.automations.find((candidate) => candidate.id === automationId);
  const runs = (runsState.data?.runs ?? [])
    .filter((run) => run.automationId === automationId)
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
  const human = automation.schedule ? humanizeSchedule(automation.schedule) : undefined;
  const prompt = automation.prompt.trim();
  const lastRun = automation.lastRun;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="min-w-0 text-lg font-semibold break-words">{automation.id}</h2>
        <StatusPill tone={automation.enabled ? "success" : "neutral"}>
          {automation.enabled ? "Enabled" : "Disabled"}
        </StatusPill>
        <div className="toolbar-spacer" />
        {automation.enabled ? (
          <Button
            size="sm"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void runNow(automation)}
            title="Runs through the same pipeline as a scheduled run and is recorded with the manual origin"
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
            <Fact label="Repository">{automation.repo ?? "–"}</Fact>
            <Fact label="Opens PR">
              {automation.openPr ? (
                <span className="inline-flex items-center gap-1">
                  <GitPullRequest className="size-3.5" aria-hidden="true" /> Yes
                </span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </Fact>
            <Fact label="Last run">
              {lastRun ? (
                <a
                  href={`#/runs/${lastRun.id}`}
                  className="inline-flex items-center gap-2"
                  aria-label={`Open last run for ${automation.id}`}
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
          <RecentRuns
            runs={runs}
            loading={runsState.loading}
            error={runsState.data ? null : runsState.error}
          />
        </aside>
        <section aria-labelledby="ad-prompt" className="ad-main min-w-0 space-y-3">
          <div className="flex max-w-[72ch] items-center gap-2">
            <h3 id="ad-prompt" className="section-title">
              Prompt
            </h3>
            <CopyPromptButton text={prompt} />
          </div>
          <div className="max-w-[72ch]">
            <Markdown>{prompt}</Markdown>
          </div>
        </section>
      </div>
    </div>
  );
}
