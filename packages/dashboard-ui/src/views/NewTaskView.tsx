import { useState } from "react";
import type { FormEvent } from "react";
import { CircleCheck, Info, Send } from "lucide-react";

import { EmptyState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createTask, usePoll, WORKSPACE_URL } from "@/lib/api";
import type { CreatedTask, RunsResponse, WorkspaceResponse } from "@/lib/api";
import { RUNS_HASH, runHash } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** Mirrors the server's body cap (`MAX_INJECTED_BODY_CHARS`). */
export const MAX_TASK_BODY_CHARS = 20_000;

/** The editable fields of the "New task" form. */
export interface TaskDraft {
  repo: string;
  title: string;
  body: string;
}

/** Initial draft: preselect the repo when the workspace has exactly one. */
export function emptyTaskDraft(repos: readonly string[]): TaskDraft {
  return { repo: repos.length === 1 ? (repos[0] ?? "") : "", title: "", body: "" };
}

/** Why the draft cannot be submitted yet, or null when it is ready. */
export function taskDraftError(draft: TaskDraft, repos: readonly string[]): string | null {
  if (!draft.repo || !repos.includes(draft.repo)) return "Choose a repository.";
  if (!draft.title.trim()) return "Give the task a title.";
  if (draft.body.length > MAX_TASK_BODY_CHARS) {
    return `The description is ${draft.body.length - MAX_TASK_BODY_CHARS} characters over the limit.`;
  }
  return null;
}

/**
 * A fresh idempotency key for one form instance: a double-click or a retry of
 * the same submission reuses it, so the server returns the existing task.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return `dashboard-${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `dashboard-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const FIELD_CLASS =
  "w-full rounded-lg border border-border-strong bg-card px-3 text-[0.8125rem] text-foreground outline-none transition-[border-color] duration-150 placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive";

/** Bypass/PR side effects the operator should know before dispatching. */
export function NewTaskNotice() {
  return (
    <div
      role="note"
      className="flex gap-2.5 rounded-lg border border-info-border bg-info-subtle px-3.5 py-3 text-[0.8125rem] text-foreground"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
      <p>
        A running worker starts this task on its next poll. Ad-hoc tasks bypass quiet hours (working
        windows) and inherit <code>[defaults].worker_task_args</code>, which defaults to{" "}
        <code>--create-pr</code>, so a pull request may open as soon as the run finishes.
      </p>
    </div>
  );
}

export interface NewTaskFormProps {
  repos: readonly string[];
  draft: TaskDraft;
  onDraftChange: (next: TaskDraft) => void;
  onSubmit: () => void;
  submitting: boolean;
  /** Server/network failure from the last submit. */
  error: string | null;
}

/** Presentational "New task" form (state lives in {@link NewTaskView}). */
export function NewTaskForm({
  repos,
  draft,
  onDraftChange,
  onSubmit,
  submitting,
  error,
}: NewTaskFormProps) {
  const invalid = taskDraftError(draft, repos);
  const overLimit = draft.body.length > MAX_TASK_BODY_CHARS;
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!invalid && !submitting) onSubmit();
  };

  return (
    <form className="flex max-w-3xl flex-col gap-5" onSubmit={handleSubmit} noValidate>
      <NewTaskNotice />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-task-repo" className="text-xs font-medium text-muted-foreground">
          Repository
        </label>
        <Select
          value={draft.repo || undefined}
          onValueChange={(repo) => onDraftChange({ ...draft, repo })}
          disabled={submitting}
        >
          <SelectTrigger id="new-task-repo" className="w-full max-w-sm">
            <SelectValue placeholder="Choose a repository">{draft.repo || undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {repos.map((repo) => (
                <SelectItem key={repo} value={repo}>
                  {repo}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-task-title" className="text-xs font-medium text-muted-foreground">
          Title
        </label>
        <input
          id="new-task-title"
          type="text"
          className={cn(FIELD_CLASS, "h-9")}
          value={draft.title}
          onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
          placeholder="Fix the flaky checkout test"
          required
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="new-task-body" className="text-xs font-medium text-muted-foreground">
            Description <span className="font-normal text-subtle-foreground">(Markdown)</span>
          </label>
          <span
            id="new-task-body-count"
            className={cn(
              "text-xs tabular-nums",
              overLimit ? "text-danger" : "text-subtle-foreground",
            )}
            aria-live="polite"
          >
            {draft.body.length.toLocaleString("en-US")} /{" "}
            {MAX_TASK_BODY_CHARS.toLocaleString("en-US")}
          </span>
        </div>
        <textarea
          id="new-task-body"
          className={cn(FIELD_CLASS, "min-h-56 resize-y py-2 font-mono text-xs leading-relaxed")}
          value={draft.body}
          onChange={(event) => onDraftChange({ ...draft, body: event.target.value })}
          placeholder={
            "What should change and why, relevant files, acceptance criteria, and how to verify.\n" +
            "The worker sees only this text, so keep it self-contained. Never include credentials."
          }
          aria-describedby="new-task-body-count"
          aria-invalid={overLimit || undefined}
          disabled={submitting}
        />
      </div>

      {error ? (
        <p role="alert" className="text-[0.8125rem] text-danger">
          Could not enqueue the task: {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={invalid !== null} aria-busy={submitting || undefined}>
          <Send aria-hidden="true" />
          {submitting ? "Enqueuing…" : "Enqueue task"}
        </Button>
        {invalid && (draft.title || draft.body) ? (
          <span className="text-xs text-subtle-foreground">{invalid}</span>
        ) : null}
      </div>
    </form>
  );
}

/** Success panel: the enqueued task, and its run once the worker starts it. */
export function NewTaskResult({
  task,
  runId,
  onCreateAnother,
}: {
  task: CreatedTask;
  /** Latest run for the task key, once the worker has picked it up. */
  runId?: number;
  onCreateAnother: () => void;
}) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div
        role="status"
        className="flex gap-2.5 rounded-lg border border-success-border bg-success-subtle px-3.5 py-3 text-[0.8125rem]"
      >
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {task.deduplicated ? "Already queued" : "Enqueued"} <code>{task.taskKey}</code> for{" "}
            <code>{task.repo}</code> (task #{task.id}, {task.status}).
          </p>
          {task.deduplicated ? (
            <p className="text-muted-foreground">
              This submission matched a task that is still pending or running, so no duplicate was
              created.
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {runId !== undefined
              ? "The worker has started it."
              : "It appears in Runs once the worker picks it up; no worker is started for you."}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {runId !== undefined ? (
          <Button asChild>
            <a href={runHash(runId)}>Open run #{runId}</a>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <a href={RUNS_HASH}>View runs</a>
          </Button>
        )}
        <Button variant="ghost" onClick={onCreateAnother}>
          Create another task
        </Button>
      </div>
    </div>
  );
}

/** Polls for the run the worker records for a freshly enqueued task. */
function CreatedTaskPanel({
  task,
  onCreateAnother,
}: {
  task: CreatedTask;
  onCreateAnother: () => void;
}) {
  const params = new URLSearchParams({ taskKey: task.taskKey, limit: "1" });
  const { data } = usePoll<RunsResponse>(`/api/runs?${params}`, 3000);
  return <NewTaskResult task={task} runId={data?.runs[0]?.id} onCreateAnother={onCreateAnother} />;
}

/** Form state for one set of repos; remounted per "Create another". */
function NewTaskEditor({ repos }: { repos: readonly string[] }) {
  const [draft, setDraft] = useState<TaskDraft>(() => emptyTaskDraft(repos));
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedTask | null>(null);

  if (created) {
    return (
      <CreatedTaskPanel
        task={created}
        onCreateAnother={() => {
          setCreated(null);
          setDraft(emptyTaskDraft(repos));
          setIdempotencyKey(newIdempotencyKey());
        }}
      />
    );
  }

  const submit = () => {
    setSubmitting(true);
    setError(null);
    void createTask({ ...draft, idempotencyKey })
      .then((result) => {
        if (result.ok) setCreated(result.task);
        else setError(result.error);
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <NewTaskForm
      repos={repos}
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={submit}
      submitting={submitting}
      error={error}
    />
  );
}

/** `#/tasks/new`: enqueue an ad-hoc task (the dashboard's `devintern worker add`). */
export function NewTaskView() {
  const { data, error } = usePoll<WorkspaceResponse>(WORKSPACE_URL, 30_000);

  if (error) return <EmptyState title="Could not load the workspace" body={error} />;
  if (!data) return <div className="skeleton h-64 max-w-3xl rounded-lg" />;
  if (data.status !== "ok") {
    return (
      <EmptyState
        title="Ad-hoc tasks need a workspace"
        body={`${data.error} Register a repository with \`devintern worker add-repo\`, then dispatch tasks here or with \`devintern worker add\`.`}
      />
    );
  }
  const repos = data.config.repos.map((repo) => repo.name);
  if (repos.length === 0) {
    return (
      <EmptyState
        title="No repositories registered"
        body="Register a checkout with `devintern worker add-repo` before dispatching tasks."
      />
    );
  }
  return <NewTaskEditor repos={repos} />;
}
