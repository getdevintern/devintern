/**
 * Friendly rendering of parsed stage-detail fields (see `lib/stage-detail.ts`).
 *
 * Scalar fields (booleans, scores, counts, durations, short text) collapse
 * into one inline facts row; richer fields (lists, findings, issues, nested
 * fields, prose) render as labelled blocks below it. `FieldChips` and
 * `FieldBlocks` are exported so a caller can place prose between the two.
 */
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import type { StatusTone } from "@/components/shared";
import { Markdown } from "@/lib/markdown";
import { cn, formatDuration } from "@/lib/utils";
import type { DetailField, FieldValue, Issue, ReviewItem } from "@/lib/stage-detail";

const SEVERITY_TONES: Record<string, StatusTone> = {
  critical: "danger",
  major: "warning",
  minor: "neutral",
};

const PRIORITY_TONES: Record<string, StatusTone> = {
  critical: "danger",
  high: "warning",
  medium: "attention",
  low: "neutral",
  info: "info",
};

/** True for values that read well as a compact "label value" pair. */
function isCompact(value: FieldValue): boolean {
  switch (value.kind) {
    case "bool":
    case "score":
    case "count":
    case "duration":
      return true;
    case "text":
      return value.text.length <= 60 && !value.text.includes("\n");
    default:
      return false;
  }
}

export function splitFields(fields: DetailField[]): {
  compact: DetailField[];
  blocks: DetailField[];
} {
  return {
    compact: fields.filter((field) => isCompact(field.value)),
    blocks: fields.filter((field) => !isCompact(field.value)),
  };
}

export function StageDetailFields({ fields }: { fields: DetailField[] }) {
  const { compact, blocks } = splitFields(fields);
  return (
    <div className="space-y-4">
      <FieldChips fields={compact} />
      <FieldBlocks fields={blocks} />
    </div>
  );
}

/** Inline facts row for scalar fields. */
export function FieldChips({ fields }: { fields: DetailField[] }) {
  if (fields.length === 0) {
    return null;
  }
  return (
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.8125rem]">
      {fields.map((field) => (
        <div key={field.label} className="flex items-center gap-2">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className={cn("font-medium", chipTone(field))}>{renderValue(field.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Dim zero counts, flag non-zero blocking findings. */
function chipTone(field: DetailField): string | undefined {
  if (field.value.kind === "count" && /blocking/i.test(field.label)) {
    return field.value.n > 0 ? "text-danger" : "text-muted-foreground";
  }
  return undefined;
}

/** Labelled blocks for rich fields. */
export function FieldBlocks({ fields }: { fields: DetailField[] }) {
  if (fields.length === 0) {
    return null;
  }
  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <section key={field.label}>
          <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
            {field.label}
            {countOf(field.value)}
          </h4>
          {renderValue(field.value)}
        </section>
      ))}
    </div>
  );
}

function countOf(value: FieldValue): ReactNode {
  if (value.kind === "issues" || value.kind === "reviewItems" || value.kind === "list") {
    return <span className="tabular ml-1.5 text-subtle-foreground">{value.items.length}</span>;
  }
  return null;
}

function renderValue(value: FieldValue): ReactNode {
  switch (value.kind) {
    case "text":
      return <span className="whitespace-pre-wrap break-words">{value.text}</span>;
    case "markdown":
      return <Markdown>{value.text}</Markdown>;
    case "bool":
      return <BoolValue value={value} />;
    case "duration":
      return <span className="tabular">{formatDuration(value.ms)}</span>;
    case "score":
      return (
        <span className="tabular">
          {value.value}
          {value.max ? `/${value.max}` : ""}
        </span>
      );
    case "count":
      return (
        <span className="tabular">
          {value.n} {value.noun ? pluralize(value.noun, value.n) : ""}
        </span>
      );
    case "list":
      return <FieldValueList items={value.items} />;
    case "fields":
      return <StageDetailFields fields={value.fields} />;
    case "issues":
      return <IssueList items={value.items} />;
    case "reviewItems":
      return <ReviewItemList items={value.items} />;
  }
}

function BoolValue({ value }: { value: Extract<FieldValue, { kind: "bool" }> }) {
  const yes = value.yes ?? "yes";
  const no = value.no ?? "no";
  const truthy = value.value;
  return (
    <Badge variant={truthy ? "success" : "danger"}>
      {truthy ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
      {truthy ? yes : no}
    </Badge>
  );
}

function fieldValueKey(value: FieldValue): string {
  switch (value.kind) {
    case "text":
    case "markdown":
      return `${value.kind}:${value.text}`;
    case "bool":
      return `bool:${value.value}:${value.yes ?? ""}:${value.no ?? ""}`;
    case "duration":
      return `duration:${value.ms}`;
    case "score":
      return `score:${value.value}:${value.max ?? ""}`;
    case "count":
      return `count:${value.n}:${value.noun ?? ""}`;
    case "list":
      return `list:${value.items.map(fieldValueKey).join("|")}`;
    case "fields":
      return `fields:${value.fields.map((f) => f.label).join("|")}`;
    case "issues":
      return `issues:${value.items.map(issueKey).join("|")}`;
    case "reviewItems":
      return `review:${value.items.map(reviewItemKey).join("|")}`;
  }
}

function issueKey(issue: Issue): string {
  return `${issue.severity}:${issue.category}:${issue.description}`;
}

function reviewItemKey(item: ReviewItem): string {
  return `${item.priority}:${item.category}:${item.file ?? ""}:${item.line ?? ""}:${item.issue}`;
}

function FieldValueList({ items }: { items: FieldValue[] }) {
  return (
    <ul className="max-w-[72ch] list-disc space-y-1.5 pl-5 text-[0.875rem] leading-[1.55] marker:text-subtle-foreground">
      {items.map((item) => (
        <li key={fieldValueKey(item)}>{renderValue(item)}</li>
      ))}
    </ul>
  );
}

/** One bordered list with hairline dividers: never a card per finding. */
function FindingList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-muted/50">
      {children}
    </ul>
  );
}

function FindingRow({ badge, children }: { badge: ReactNode; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:gap-3">
      <div className="shrink-0 sm:w-[4.5rem]">{badge}</div>
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </li>
  );
}

function IssueList({ items }: { items: Issue[] }) {
  return (
    <FindingList>
      {items.map((issue) => (
        <FindingRow
          key={issueKey(issue)}
          badge={
            <Badge variant={SEVERITY_TONES[issue.severity] ?? "neutral"}>{issue.severity}</Badge>
          }
        >
          <div className="font-mono text-xs text-foreground">{issue.category}</div>
          {issue.description ? (
            <p className="max-w-[72ch] whitespace-pre-wrap break-words text-[0.8125rem] leading-[1.55] text-muted-foreground">
              {issue.description}
            </p>
          ) : null}
        </FindingRow>
      ))}
    </FindingList>
  );
}

function ReviewItemList({ items }: { items: ReviewItem[] }) {
  return (
    <FindingList>
      {items.map((item) => (
        <FindingRow
          key={reviewItemKey(item)}
          badge={<Badge variant={PRIORITY_TONES[item.priority] ?? "info"}>{item.priority}</Badge>}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {item.file ? (
              <code className="break-all font-mono text-xs text-foreground">
                {item.file}
                {item.line ? `:${item.line}` : ""}
              </code>
            ) : null}
            <span className="text-xs text-subtle-foreground">{item.category}</span>
          </div>
          {item.issue ? (
            <p className="max-w-[72ch] whitespace-pre-wrap break-words text-[0.8125rem] leading-[1.55]">
              {item.issue}
            </p>
          ) : null}
          {item.suggestion ? (
            <p className="max-w-[72ch] whitespace-pre-wrap break-words text-[0.8125rem] leading-[1.55] text-muted-foreground">
              <span className="font-medium text-foreground">Suggestion: </span>
              {item.suggestion}
            </p>
          ) : null}
        </FindingRow>
      ))}
    </FindingList>
  );
}

function pluralize(noun: string, n: number): string {
  return n === 1 ? noun : `${noun}s`;
}
