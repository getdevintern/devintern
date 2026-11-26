import { Bug, Hand, PlugZap, UserX } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { RunOutcomeClass } from "@/lib/api";
import { OUTCOME_CLASS_META } from "@/lib/run-outcome";
import { cn } from "@/lib/utils";

const CLASS_ICON: Record<RunOutcomeClass, LucideIcon> = {
  review_hold: Hand,
  agent: UserX,
  internal: Bug,
  environment: PlugZap,
};

/**
 * Each class differs in icon, label, and border style as well as color, so
 * the badge reads without color: a DevIntern problem is solid, a review hold
 * dashed.
 */
const CLASS_STYLE: Record<
  RunOutcomeClass,
  { variant: "danger" | "warning" | "neutral" | "attention"; className?: string }
> = {
  internal: { variant: "danger", className: "font-semibold" },
  environment: { variant: "warning" },
  agent: { variant: "neutral" },
  review_hold: { variant: "attention", className: "border-dashed" },
};

/** Icon + label badge for a run's outcome class. */
export function OutcomeClassBadge({
  outcomeClass,
  className,
}: {
  outcomeClass: RunOutcomeClass;
  className?: string;
}) {
  const Icon = CLASS_ICON[outcomeClass];
  const style = CLASS_STYLE[outcomeClass];
  return (
    <Badge
      variant={style.variant}
      data-outcome-class={outcomeClass}
      className={cn(style.className, className)}
    >
      <Icon aria-hidden="true" />
      {OUTCOME_CLASS_META[outcomeClass].label}
    </Badge>
  );
}
