import { useEffect } from "react";
import { consumeHarnessFocus, HARNESS_SECTION_ID } from "@/components/overview/focus";
import {
  formatClock,
  formatIn,
  harnessSummary,
  resumingHarness,
} from "@/components/overview/overview-model";
import type { OverviewHarnessEntry, OverviewHarnesses } from "@/lib/api-overview";
import { PANEL, Section } from "@/components/overview/OverviewPanel";

const HARNESS_SOURCE_LABELS: Record<OverviewHarnesses["source"], string> = {
  workspace_env: "Chain from AGENT_HARNESS in the workspace .env",
  process_env: "Chain from AGENT_HARNESS in the dashboard's environment",
  default: "Default chain (AGENT_HARNESS is not set)",
};

function HarnessRow({
  entry,
  last,
  resumesFirst,
  workerRunning,
  busy,
  now,
}: {
  entry: OverviewHarnessEntry;
  last: boolean;
  resumesFirst: boolean;
  workerRunning: boolean;
  busy: boolean;
  now: number;
}) {
  // While every entry is limited the backend still marks the primary active;
  // nothing is actually in use, so the tag moves to the harness that resumes.
  // A stopped worker uses nothing.
  const inUse = workerRunning && entry.active && entry.state !== "limited";
  return (
    <li
      className="ov-harness grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5"
      data-state={entry.state}
      data-active={inUse ? "" : undefined}
      data-last={last ? "" : undefined}
    >
      <span className="ov-harness-node" aria-hidden="true">
        {entry.priority + 1}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <span className="truncate">{entry.name}</span>
          {inUse ? (
            busy ? (
              <span className="text-xs font-medium text-primary">in use</span>
            ) : (
              <span className="text-xs text-subtle-foreground">next up</span>
            )
          ) : null}
          {resumesFirst ? (
            <span className="text-xs font-medium text-warning">resumes first</span>
          ) : null}
        </span>
        <span className="text-xs text-subtle-foreground">
          {!entry.known ? (
            <span className="text-danger">not a registered harness</span>
          ) : entry.priority === 0 ? (
            "primary"
          ) : (
            `fallback ${entry.priority}`
          )}
        </span>
      </span>
      <span className="flex flex-col items-end text-[0.8125rem] whitespace-nowrap">
        {entry.state === "healthy" ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="status-dot text-success" aria-hidden="true" />
            healthy
          </span>
        ) : entry.state === "limited" ? (
          <>
            <span className="inline-flex items-center gap-1.5 font-medium text-warning">
              <span className="status-dot" aria-hidden="true" />
              {entry.limitedUntil !== undefined
                ? `limited until ${formatClock(entry.limitedUntil, now)}`
                : "limited"}
            </span>
            {entry.limitedUntil !== undefined ? (
              <span className="text-xs text-subtle-foreground tabular-nums">
                {formatIn(entry.limitedUntil, now)}
              </span>
            ) : null}
          </>
        ) : entry.state === "unconfirmed" ? (
          <>
            <span
              className="inline-flex items-center gap-1.5 font-medium text-warning"
              title="The worker only learns the quota is back when an agent run succeeds; it has not run on this harness since the limit."
            >
              <span className="status-dot" aria-hidden="true" />
              quota unconfirmed
            </span>
            <span className="text-xs text-subtle-foreground tabular-nums">
              {entry.limitEndedAt !== undefined
                ? `limit window ended ${formatClock(entry.limitEndedAt, now)} · no run since`
                : "no run since its last limit"}
            </span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-neutral">
            <span className="status-dot" aria-hidden="true" />
            unknown
          </span>
        )}
      </span>
    </li>
  );
}

export function HarnessSection({
  harnesses,
  configMissing,
  queueDbMissing,
  workerRunning,
  busy,
  now,
}: {
  harnesses: OverviewHarnesses;
  workerRunning: boolean;
  /** The worker is running and at least one run is in flight. */
  busy: boolean;
  configMissing: boolean;
  queueDbMissing: boolean;
  now: number;
}) {
  useEffect(() => consumeHarnessFocus(), []);
  const summary = harnessSummary(harnesses);
  const resumesWith = harnesses.allExhausted ? resumingHarness(harnesses) : undefined;
  const drift =
    harnesses.persistedActive &&
    harnesses.active &&
    !harnesses.allExhausted &&
    harnesses.persistedActive !== harnesses.active;
  return (
    <div id={HARNESS_SECTION_ID} tabIndex={-1} className="ov-focus-target rounded-lg">
      <Section
        id="ov-harness"
        title="Agent harnesses"
        meta={
          <span
            className={summary.tone === "warning" ? "font-medium text-warning" : undefined}
            title={HARNESS_SOURCE_LABELS[harnesses.source]}
          >
            {summary.label}
          </span>
        }
      >
        <div className={PANEL}>
          {!harnesses.stateAvailable ? (
            <p className="border-b border-border bg-neutral-subtle px-4 py-2.5 text-xs text-muted-foreground">
              {queueDbMissing
                ? `Usage limits are unknown: the worker records them in its queue database, which does not exist yet${
                    configMissing ? ". Create workspace.toml and start the worker once." : "."
                  }`
                : "Usage limits could not be read from the queue database, so health is unknown."}
            </p>
          ) : null}
          {harnesses.entries.length > 0 ? (
            <ol className="py-1.5" aria-label="Failover order">
              {harnesses.entries.map((entry, index) => (
                <HarnessRow
                  key={entry.name}
                  entry={entry}
                  now={now}
                  resumesFirst={entry.name === resumesWith}
                  workerRunning={workerRunning}
                  busy={busy}
                  last={index === harnesses.entries.length - 1}
                />
              ))}
            </ol>
          ) : (
            <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">
              No harness chain resolved.
            </p>
          )}
        </div>
        {drift ? (
          <p className="mt-2 text-xs text-subtle-foreground">
            The worker last reported{" "}
            <strong className="font-semibold text-muted-foreground">
              {harnesses.persistedActive}
            </strong>{" "}
            as active; it switches on its next run.
          </p>
        ) : harnesses.entries.length > 1 && !harnesses.allExhausted ? (
          <p className="mt-2 text-xs text-subtle-foreground">
            Work falls back down the chain when a harness hits its usage limit.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

/* ---------- Tracker sources ---------- */
