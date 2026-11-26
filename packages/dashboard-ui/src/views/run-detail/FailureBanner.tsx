import { useState } from "react";
import { Bug, ExternalLink, FolderOpen, GitBranch, TriangleAlert } from "lucide-react";

import { OutcomeClassBadge } from "@/components/OutcomeClassBadge";
import { Button } from "@/components/ui/button";
import type { RunRecord } from "@/lib/api";
import { OUTCOME_CLASS_META, isUnsuccessfulRun, runBranchHref, runCause } from "@/lib/run-outcome";
import { cn } from "@/lib/utils";
import { ReportDialog, reportDraftForRun } from "./ReportProblem";

const BANNER_TONE: Record<NonNullable<RunRecord["outcomeClass"]>, string> = {
  internal: "border-danger-border bg-danger-subtle",
  environment: "border-warning-border bg-warning-subtle",
  agent: "border-border-strong bg-card",
  review_hold: "border-attention-border border-dashed bg-attention-subtle",
};

/** Where the run's work went: a saved branch (linked when possible), a kept path, or discarded. */
function WorkStatus({ run }: { run: RunRecord }) {
  if (run.workStatus === "saved") {
    const branch = run.workRef;
    const href = branch ? runBranchHref(run, branch) : undefined;
    return (
      <p className="flex items-center gap-2 text-[0.8125rem]">
        <GitBranch className="size-4 shrink-0 text-success" aria-hidden="true" />
        <span>
          Work saved on branch{" "}
          {branch ? (
            href ? (
              <a href={href} target="_blank" rel="noreferrer" className="ref-link font-mono">
                {branch}
                <ExternalLink className="ml-1 inline size-3" aria-hidden="true" />
              </a>
            ) : (
              <code className="font-mono">{branch}</code>
            )
          ) : (
            "its task branch"
          )}
        </span>
      </p>
    );
  }
  if (run.workStatus === "kept") {
    return (
      <p className="flex items-center gap-2 text-[0.8125rem]">
        <FolderOpen className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <span>
          Work kept in worktree{" "}
          {run.workRef ? (
            <code className="font-mono [overflow-wrap:anywhere]">{run.workRef}</code>
          ) : (
            "on the worker"
          )}
        </span>
      </p>
    );
  }
  if (run.workStatus === "discarded") {
    return (
      <p className="flex items-center gap-2 text-[0.8125rem] font-semibold text-danger">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        <span>Work discarded: the unfinished changes of this run could not be saved.</span>
      </p>
    );
  }
  return null;
}

/**
 * Top-of-page banner for a run that did not succeed: its outcome class,
 * failing stage and cause, where its work went, and (for a DevIntern-side
 * failure) a Report problem action with the stage and cause pre-filled.
 */
export function FailureBanner({ run, canReport = true }: { run: RunRecord; canReport?: boolean }) {
  const [reporting, setReporting] = useState(false);
  if (!isUnsuccessfulRun(run) || (!run.outcomeClass && !run.workStatus)) return null;
  const cause = runCause(run);
  const meta = run.outcomeClass ? OUTCOME_CLASS_META[run.outcomeClass] : undefined;
  return (
    <section
      aria-label="Why this run did not succeed"
      data-outcome-class={run.outcomeClass}
      className={cn(
        "space-y-2 rounded-lg border px-4 py-3",
        run.outcomeClass ? BANNER_TONE[run.outcomeClass] : "border-border bg-card",
        run.workStatus === "discarded" && "border-danger-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {run.outcomeClass ? <OutcomeClassBadge outcomeClass={run.outcomeClass} /> : null}
        {run.failureStage ? (
          <span className="text-sm font-semibold">
            <span className="sr-only">Failing stage: </span>
            {run.failureStage} failed
          </span>
        ) : null}
        <span className="flex-1" />
        {run.outcomeClass === "internal" && canReport ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setReporting(true)}>
              <Bug />
              Report problem
            </Button>
            <ReportDialog
              open={reporting}
              onOpenChange={setReporting}
              runId={run.id}
              initialDraft={reportDraftForRun(run)}
            />
          </>
        ) : null}
      </div>
      {cause ? (
        <p className="max-w-[80ch] text-[0.9375rem] leading-[1.5] [overflow-wrap:anywhere]">
          <span className="sr-only">Cause: </span>
          {cause}
        </p>
      ) : null}
      <WorkStatus run={run} />
      {meta ? (
        <p className="max-w-[80ch] text-[0.8125rem] text-muted-foreground">{meta.description}</p>
      ) : null}
    </section>
  );
}
