import { ExternalLink } from "lucide-react";

import { StatusBadge } from "@/components/shared";
import type { RunLineageParent, SpawnedWork } from "@/lib/api";
import { formatRunOrigin } from "@/lib/run-origin";
import { runHash } from "@/lib/routes";
import { formatTime } from "@/lib/utils";
import {
  groupSpawned,
  hasSpawnedWork,
  queueStatusLabel,
  safeHref,
  sourcedFromLabel,
} from "./lineage-labels";

/** Facts-rail value: a link to the run this run was sourced from. */
export function SourcedFrom({ parent }: { parent: RunLineageParent }) {
  return (
    <a href={runHash(parent.runId)} className="ref-link" title="Open the source run">
      {sourcedFromLabel(parent)}
    </a>
  );
}

function ExternalRef({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ref-link">
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 id={id} className="text-xs text-subtle-foreground">
        {title}
      </h4>
      <ul aria-labelledby={id} className="space-y-2">
        {children}
      </ul>
    </div>
  );
}

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.8125rem]";

/**
 * Work this run created outside itself: delegated ad-hoc tasks with their live
 * status, tracker tickets it filed, and follow-up runs on the PR it opened.
 * Renders nothing when the run spawned nothing.
 */
export function SpawnedWorkSection({ spawned }: { spawned: readonly SpawnedWork[] | undefined }) {
  const groups = groupSpawned(spawned);
  if (!hasSpawnedWork(groups)) return null;
  return (
    <section
      aria-labelledby="rd-spawned-heading"
      className="space-y-4 rounded-lg border border-border bg-card px-4 py-4 sm:px-5"
    >
      <h3 id="rd-spawned-heading" className="section-title">
        Spawned work
      </h3>
      {groups.tasks.length > 0 ? (
        <Group id="rd-spawned-tasks" title="Delegated tasks">
          {groups.tasks.map((task) => {
            const prHref = safeHref(task.prUrl);
            return (
              <li key={`task-${task.taskKey}`} className={ROW}>
                {task.latestRunId !== undefined ? (
                  <a href={runHash(task.latestRunId)} className="ref-link font-medium">
                    {task.title ?? task.taskKey}
                  </a>
                ) : (
                  <span className="font-medium">{task.title ?? task.taskKey}</span>
                )}
                {task.latestRunStatus ? (
                  <StatusBadge status={task.latestRunStatus} />
                ) : (
                  <span className="text-muted-foreground">{queueStatusLabel(task.status)}</span>
                )}
                {prHref ? (
                  <ExternalRef href={prHref}>
                    {task.prNumber !== undefined ? `PR #${task.prNumber}` : "PR"}
                  </ExternalRef>
                ) : null}
                <code className="font-mono text-xs text-subtle-foreground">{task.taskKey}</code>
              </li>
            );
          })}
        </Group>
      ) : null}
      {groups.issues.length > 0 ? (
        <Group id="rd-spawned-issues" title="Tracker tickets">
          {groups.issues.map((issue) => {
            const href = safeHref(issue.url);
            return (
              <li key={`issue-${issue.key}`} className={ROW}>
                {href ? (
                  <ExternalRef href={href}>{issue.key}</ExternalRef>
                ) : (
                  <span>{issue.key}</span>
                )}
                {issue.title ? <span>{issue.title}</span> : null}
                {issue.tracker ? (
                  <span className="text-xs text-subtle-foreground">{issue.tracker}</span>
                ) : null}
              </li>
            );
          })}
        </Group>
      ) : null}
      {groups.followUps.length > 0 ? (
        <Group id="rd-spawned-follow-ups" title="Follow-up runs">
          {groups.followUps.map((run) => (
            <li key={`run-${run.runId}`} className={ROW}>
              <a href={runHash(run.runId)} className="ref-link font-medium">
                Run #{run.runId}
              </a>
              <span>{formatRunOrigin(run.origin)}</span>
              <StatusBadge status={run.status} />
              <span className="tabular text-xs text-subtle-foreground">
                {formatTime(run.startedAt)}
              </span>
            </li>
          ))}
        </Group>
      ) : null}
    </section>
  );
}
