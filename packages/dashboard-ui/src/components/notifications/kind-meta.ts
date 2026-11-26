import {
  CircleAlert,
  GitMerge,
  GitPullRequest,
  PlugZap,
  RefreshCcwDot,
  Split,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { StatusTone } from "@/components/shared";
import type { NotificationKind } from "@/lib/api-notifications";

export interface KindMeta {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
}

/** Icon, label, and tone for each notification kind. */
export const KIND_META: Record<NotificationKind, KindMeta> = {
  escalated: { label: "Escalated", icon: CircleAlert, tone: "attention" },
  retries_exhausted: { label: "Retries exhausted", icon: RefreshCcwDot, tone: "danger" },
  automation_broke: { label: "Automation broke", icon: Workflow, tone: "danger" },
  source_unhealthy: { label: "Source unhealthy", icon: PlugZap, tone: "warning" },
  work_spawned: { label: "Spawned work", icon: Split, tone: "info" },
  pr_opened: { label: "PR opened", icon: GitPullRequest, tone: "success" },
  pr_auto_merged: { label: "PR auto-merged", icon: GitMerge, tone: "success" },
};

export const TONE_ICON_CLASS: Record<StatusTone, string> = {
  success: "border-success-border bg-success-subtle text-success",
  warning: "border-warning-border bg-warning-subtle text-warning",
  danger: "border-danger-border bg-danger-subtle text-danger",
  info: "border-info-border bg-info-subtle text-info",
  attention: "border-attention-border bg-attention-subtle text-attention",
  neutral: "border-neutral-border bg-neutral-subtle text-neutral",
};
