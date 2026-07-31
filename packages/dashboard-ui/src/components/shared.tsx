/** Dashboard-specific composites built on the shadcn/ui primitives. */

import type { ReactNode } from "react";

import type { RunStatus, StageStatus } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<RunStatus, string> = {
  in_progress: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  succeeded: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  deferred: "bg-chart-5/15 text-chart-5 border-chart-5/30",
  escalated: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  abandoned: "bg-muted text-muted-foreground border-border",
};

const STATUS_LABELS: Record<RunStatus, string> = {
  in_progress: "in progress",
  succeeded: "succeeded",
  failed: "failed",
  deferred: "deferred",
  escalated: "escalated",
  abandoned: "abandoned",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant="outline" className={STATUS_STYLES[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function StageBadge({ status }: { status: StageStatus }) {
  const styles: Record<StageStatus, string> = {
    succeeded: STATUS_STYLES.succeeded,
    failed: STATUS_STYLES.failed,
    skipped: STATUS_STYLES.abandoned,
    deferred: STATUS_STYLES.deferred,
    escalated: STATUS_STYLES.escalated,
    abandoned: STATUS_STYLES.abandoned,
  };
  return (
    <Badge variant="outline" className={styles[status]}>
      {status}
    </Badge>
  );
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? <CardContent className="text-xs text-muted-foreground">{hint}</CardContent> : null}
    </Card>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card className="py-10 text-center">
      <CardContent>
        <div className="text-lg font-medium">{title}</div>
        <div className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{body}</div>
      </CardContent>
    </Card>
  );
}

/** Single-select toggle group used for the status/origin/window filters. */
export function FilterGroup<T extends string>({
  options,
  value,
  onChange,
  formatLabel,
  className,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  formatLabel?: (option: T) => string;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next) {
          onChange(next as T);
        }
      }}
      className={cn("flex-wrap", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option} size="sm">
          {formatLabel ? formatLabel(option) : option.replace("_", " ")}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
