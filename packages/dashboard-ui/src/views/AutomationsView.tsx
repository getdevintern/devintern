import { useState } from "react";
import { Play } from "lucide-react";

import { RunResult } from "@/components/RunResult";
import { EmptyState, StatusBadge } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { cn, formatTime } from "@/lib/utils";

/** Feedback strip for a manual-run trigger (mirrors the retry feedback). */
function RunFeedback({ kind, message }: { kind: "success" | "error"; message: string }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        kind === "success"
          ? "border-chart-4/30 bg-chart-4/10 text-chart-4"
          : "border-destructive/30 bg-destructive/10 text-destructive",
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
  onRunNow,
  onOpenRun,
}: {
  automation: AutomationSchedule;
  busyId: string | null;
  onRunNow: (automation: AutomationSchedule) => void;
  onOpenRun: (id: number) => void;
}) {
  const busy = busyId === automation.id;
  const lastRun = automation.lastRun;
  return (
    <TableRow
      onClick={() => lastRun && onOpenRun(lastRun.id)}
      className={lastRun ? "cursor-pointer" : undefined}
    >
      <TableCell className="px-4 py-2.5 font-medium">
        <div className="flex flex-col gap-0.5">
          <span>{automation.id}</span>
          <span className="max-w-md truncate text-xs font-normal text-muted-foreground">
            {automation.prompt.split("\n")[0]}
          </span>
        </div>
      </TableCell>
      <TableCell className="px-4 py-2.5">
        {automation.schedule ? (
          <code className="font-mono text-xs">{automation.schedule}</code>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-2.5 text-muted-foreground">{automation.repo ?? "–"}</TableCell>
      <TableCell className="px-4 py-2.5 tabular-nums text-muted-foreground">
        {automation.nextDueAt ? formatTime(automation.nextDueAt) : "–"}
      </TableCell>
      <TableCell className="px-4 py-2.5">
        {lastRun ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={lastRun.status} />
            <span className="text-xs text-muted-foreground">
              {formatRunOrigin(lastRun.origin)} · {formatTime(lastRun.startedAt)}
            </span>
            <RunResult run={lastRun} />
          </div>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-2.5 text-right" onClick={(event) => event.stopPropagation()}>
        {automation.enabled ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onRunNow(automation)}
            aria-label={`Run ${automation.id} now`}
          >
            <Play /> {busy ? "Starting…" : "Run now"}
          </Button>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            title="Enable this automation in the config to run it manually"
          >
            disabled
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Scheduled automations with manual "Run now" triggering for instant validation. */
export function AutomationsView({ onOpenRun }: { onOpenRun: (id: number) => void }) {
  const { data, error, refresh } = usePoll<AutomationsResponse>("/api/automations");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );

  async function handleRunNow(automation: AutomationSchedule) {
    setBusyId(automation.id);
    setFeedback(null);
    try {
      const { ok, body } = await triggerAutomation(automation.id);
      if (ok) {
        setFeedback({
          kind: "success",
          message: `Manual run of ${automation.id} started — it will appear in the run list with origin "Manual run" shortly, including the same estimation outputs a scheduled run produces.`,
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
        <Card className="py-0">
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">Automation</TableHead>
                <TableHead className="px-4">Schedule</TableHead>
                <TableHead className="px-4">Repo</TableHead>
                <TableHead className="px-4">Next run</TableHead>
                <TableHead className="px-4">Last run</TableHead>
                <TableHead className="px-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.automations.map((automation) => (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  busyId={busyId}
                  onRunNow={(target) => void handleRunNow(target)}
                  onOpenRun={onOpenRun}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      {data && data.automations.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Press <code className="font-mono">Run now</code> to execute the automation immediately
          through the same pipeline as its scheduled runs — including estimation outputs — and
          record the attempt with the <code className="font-mono">manual</code> origin so you can
          tell those runs apart in the run list. The dashboard remains accessible only on this
          machine through a loopback address.
        </p>
      ) : null}
    </div>
  );
}
