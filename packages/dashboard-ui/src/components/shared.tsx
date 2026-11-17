/** Dashboard-specific composites built on the shadcn/ui primitives. */

import { Inbox, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { RunStatus, StageStatus } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "info" | "attention" | "neutral";

const TONE_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  attention: "text-attention",
  neutral: "text-neutral",
};

const RUN_TONES: Record<RunStatus, StatusTone> = {
  in_progress: "info",
  succeeded: "success",
  failed: "danger",
  deferred: "warning",
  escalated: "attention",
  abandoned: "neutral",
};

const STAGE_TONES: Record<StageStatus, StatusTone> = {
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
  deferred: "warning",
  escalated: "attention",
  abandoned: "neutral",
};

const STATUS_LABELS: Record<RunStatus, string> = {
  in_progress: "in progress",
  succeeded: "succeeded",
  failed: "failed",
  deferred: "deferred",
  escalated: "escalated",
  abandoned: "abandoned",
};

/** Tinted status pill: dot + label. `live` adds a reduced-motion-safe pulse. */
export function StatusPill({
  tone,
  live = false,
  children,
  className,
}: {
  tone: StatusTone;
  live?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge variant={tone} className={className}>
      <span className={cn("status-dot", live && "status-dot-live")} aria-hidden="true" />
      {children}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <StatusPill tone={RUN_TONES[status]} live={status === "in_progress"}>
      {STATUS_LABELS[status]}
    </StatusPill>
  );
}

export function StageBadge({ status }: { status: StageStatus }) {
  return <StatusPill tone={STAGE_TONES[status]}>{status}</StatusPill>;
}

/**
 * Compact metric: label, tabular value, optional context line. Optional `tone`
 * colors the value for health metrics (e.g. failures).
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: StatusTone;
}) {
  return (
    <div
      data-slot="stat-tile"
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3"
    >
      <div className="text-xs font-medium text-subtle-foreground">{label}</div>
      <div
        className={cn(
          "text-xl leading-tight font-semibold tracking-tight tabular-nums",
          tone && TONE_TEXT[tone],
        )}
      >
        {value}
      </div>
      {hint ? <div className="text-xs text-subtle-foreground">{hint}</div> : null}
    </div>
  );
}

/**
 * Teaching empty/error state: icon, title, one helpful line, optional action.
 * Titles starting with "Could not" default to the danger tone and alert icon.
 */
export function EmptyState({
  title,
  body,
  icon: Icon,
  tone,
  action,
}: {
  title: string;
  body: string;
  icon?: LucideIcon;
  tone?: "default" | "danger";
  action?: ReactNode;
}) {
  const isError = (tone ?? (title.startsWith("Could not") ? "danger" : "default")) === "danger";
  const Glyph = Icon ?? (isError ? TriangleAlert : Inbox);
  return (
    <div
      data-slot="empty-state"
      className="flex flex-col items-center rounded-lg border border-dashed border-border-strong px-6 py-10 text-center"
    >
      <span
        className={cn(
          "mb-3 grid size-10 place-items-center rounded-lg border",
          isError
            ? "border-danger-border bg-danger-subtle text-danger"
            : "border-border bg-raised text-muted-foreground",
        )}
      >
        <Glyph className="size-5" aria-hidden="true" />
      </span>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 max-w-md text-sm text-muted-foreground">{body}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Single-select toggle group used for the status/origin/window filters.
 *
 * Kept for the Stats window and Logs level filters, where three or four
 * short options read well as an always-visible toggle row; the Runs view
 * uses `FilterSelect` dropdowns instead so its two filters (with more
 * options) stay compact and leave room for the table.
 */
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

/**
 * Compact single-select dropdown for list filters. The trigger always shows
 * the filter name plus the current selection (including "all" defaults), and
 * the explicit `SelectValue` children keep the label SSR-safe.
 */
export function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  formatLabel,
  className,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  formatLabel?: (option: T) => string;
  className?: string;
}) {
  const format = (option: T): string =>
    formatLabel ? formatLabel(option) : option.replace("_", " ");

  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger size="sm" className={cn("max-w-full", className)}>
        <span className="font-normal text-subtle-foreground">{label}</span>
        <SelectValue>{format(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {format(option)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
