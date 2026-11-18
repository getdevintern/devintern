import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { capacityRatio } from "@/components/overview/overview-model";

export const PANEL = "overflow-hidden rounded-lg border border-border bg-card";

/* ---------- Building blocks ---------- */

export function Section({
  id,
  title,
  meta,
  children,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0">
      <header className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 id={`${id}-title`} className="section-title">
          {title}
        </h2>
        {meta ? (
          <div className="min-w-0 truncate text-xs text-subtle-foreground tabular-nums">{meta}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/**
 * Segmented usage meter: one segment per slot up to 24 slots, a continuous bar
 * beyond that. Only over-capacity (orphaned rows) turns it amber.
 */
export function Meter({
  running,
  max,
  label,
  size = "md",
  stalled = false,
}: {
  running: number;
  max: number;
  label: string;
  size?: "md" | "sm";
  /** The worker is stopped: the fill is neutral, not a healthy blue. */
  stalled?: boolean;
}) {
  const ratio = capacityRatio(running, max) ?? 0;
  return (
    <div
      className="ov-meter"
      data-size={size}
      data-segmented={max <= 24 ? "" : undefined}
      data-over={running > max ? "" : undefined}
      data-stalled={stalled ? "" : undefined}
      style={{ "--ov-segments": max, "--ov-fill": `${ratio * 100}%` } as React.CSSProperties}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(running, max)}
      aria-valuetext={`${running} of ${max}`}
    >
      <span className="ov-meter-fill" />
    </div>
  );
}

export function CapacityBadge({ running, max }: { running: number; max: number | null }) {
  if (max === null || running < max) return null;
  return running > max ? (
    <Badge variant="warning">over capacity</Badge>
  ) : (
    <Badge variant="neutral">at capacity</Badge>
  );
}
