/**
 * Friendly rendering of parsed stage-detail fields (see `lib/stage-detail.ts`).
 *
 * Renders structured fields as label/value pairs, with specialized layouts for
 * durations, scores, booleans, lists, nested fields, and feasibility "issues"
 * (with severity badges). Kept separate from the view so it can be reused and
 * tested in isolation if needed.
 */
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/lib/markdown";
import { formatDuration } from "@/lib/utils";
import type { DetailField, FieldValue, Issue, ReviewItem } from "@/lib/stage-detail";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  major: "bg-chart-5/15 text-chart-5 border-chart-5/30",
  minor: "bg-muted text-muted-foreground border-border",
};

const PRIORITY_STYLES: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  high: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  medium: "bg-chart-5/15 text-chart-5 border-chart-5/30",
  low: "bg-muted text-muted-foreground border-border",
  info: "bg-muted text-muted-foreground border-border",
};

export function StageDetailFields({ fields }: { fields: DetailField[] }) {
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
      {fields.map((field) => (
        <FieldRow key={field.label} field={field} />
      ))}
    </dl>
  );
}

function FieldRow({ field }: { field: DetailField }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground pt-0.5">{field.label}</dt>
      <dd className="min-w-0">{renderValue(field.value)}</dd>
    </>
  );
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
      return <span className="tabular-nums">{formatDuration(value.ms)}</span>;
    case "score":
      return (
        <span className="tabular-nums">
          {value.value}
          {value.max ? `/${value.max}` : ""}
        </span>
      );
    case "count":
      return (
        <span className="tabular-nums">
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
    <Badge
      variant="outline"
      className={
        truthy
          ? "bg-chart-4/15 text-chart-4 border-chart-4/30"
          : "bg-destructive/15 text-destructive border-destructive/30"
      }
    >
      {truthy ? `✓ ${yes}` : `✕ ${no}`}
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
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((item) => (
        <li key={fieldValueKey(item)}>{renderValue(item)}</li>
      ))}
    </ul>
  );
}

function IssueList({ items }: { items: Issue[] }) {
  return (
    <ul className="space-y-1">
      {items.map((issue) => (
        <li key={issueKey(issue)} className="rounded-md border border-border bg-muted/40 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={SEVERITY_STYLES[issue.severity] ?? SEVERITY_STYLES.minor}
            >
              {issue.severity}
            </Badge>
            <span className="text-xs font-medium">{issue.category}</span>
          </div>
          {issue.description ? (
            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
              {issue.description}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ReviewItemList({ items }: { items: ReviewItem[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={reviewItemKey(item)} className="rounded-md border border-border bg-muted/40 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.info}
            >
              {item.priority}
            </Badge>
            <span className="text-xs font-medium">{item.category}</span>
            {item.file ? (
              <code className="text-xs text-muted-foreground">
                {item.file}
                {item.line ? `:${item.line}` : ""}
              </code>
            ) : null}
          </div>
          {item.issue ? (
            <p className="mt-1 text-xs whitespace-pre-wrap break-words">{item.issue}</p>
          ) : null}
          {item.suggestion ? (
            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
              <span className="font-medium text-foreground">Suggestion: </span>
              {item.suggestion}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function pluralize(noun: string, n: number): string {
  return n === 1 ? noun : `${noun}s`;
}
