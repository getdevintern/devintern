import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, Ref } from "react";
import { CircleCheck, Info, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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

/** Whether closing would throw away typed text (title or description). */
export function isTaskDraftDirty(draft: TaskDraft): boolean {
  return draft.title.trim() !== "" || draft.body.trim() !== "";
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

/** Cmd+Enter (macOS) or Ctrl+Enter submits from the description. */
export function isSubmitShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

/**
 * A fresh idempotency key for one dialog session: a double-click or a retry of
 * the same submission reuses it, so the server returns the existing task.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return `dashboard-${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `dashboard-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const DISCARD_PROMPT = "Discard this task draft?";

/** Bypass/PR side effects the operator should know before dispatching. */
export function NewTaskNotice() {
  return (
    <div
      role="note"
      className="flex gap-2.5 rounded-lg border border-info-border bg-info-subtle px-3 py-2.5 text-xs/relaxed text-foreground"
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
  onCancel: () => void;
  submitting: boolean;
  /** Server/network failure from the last submit. */
  error: string | null;
  titleRef?: Ref<HTMLInputElement>;
}

/** Presentational "New task" form (state lives in the dialog session). */
export function NewTaskForm({
  repos,
  draft,
  onDraftChange,
  onSubmit,
  onCancel,
  submitting,
  error,
  titleRef,
}: NewTaskFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const invalid = taskDraftError(draft, repos);
  const overLimit = draft.body.length > MAX_TASK_BODY_CHARS;
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!invalid && !submitting) onSubmit();
  };
  // Enter in the single-line title must not submit a half-written task.
  const onTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
  };
  const onBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  return (
    <form ref={formRef} className="flex min-h-0 flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <NewTaskNotice />
      <FieldGroup>
        <Field data-disabled={submitting || undefined}>
          <FieldLabel htmlFor="new-task-repo">Repository</FieldLabel>
          <Select
            value={draft.repo || undefined}
            onValueChange={(repo) => onDraftChange({ ...draft, repo })}
            disabled={submitting}
          >
            <SelectTrigger id="new-task-repo" size="sm" className="w-full sm:max-w-xs">
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
        </Field>

        <Field data-disabled={submitting || undefined}>
          <FieldLabel htmlFor="new-task-title">Title</FieldLabel>
          <Input
            id="new-task-title"
            ref={titleRef}
            className="h-8"
            value={draft.title}
            onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
            onKeyDown={onTitleKeyDown}
            placeholder="Fix the flaky checkout test"
            autoComplete="off"
            autoFocus
            required
            disabled={submitting}
          />
        </Field>

        <Field data-invalid={overLimit || undefined} data-disabled={submitting || undefined}>
          <div className="flex items-baseline justify-between gap-3">
            <FieldLabel htmlFor="new-task-body">
              Description <span className="font-normal text-muted-foreground">(Markdown)</span>
            </FieldLabel>
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
          <Textarea
            id="new-task-body"
            className="h-56 max-h-[40vh] resize-y overflow-y-auto font-mono [field-sizing:fixed]"
            value={draft.body}
            onChange={(event) => onDraftChange({ ...draft, body: event.target.value })}
            onKeyDown={onBodyKeyDown}
            placeholder={
              "What should change and why, relevant files, acceptance criteria, and how to verify.\n" +
              "The worker sees only this text, so keep it self-contained. Never include credentials."
            }
            aria-describedby="new-task-body-count new-task-body-hint"
            aria-invalid={overLimit || undefined}
            disabled={submitting}
          />
          <FieldDescription id="new-task-body-hint">
            Press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> to enqueue.
          </FieldDescription>
        </Field>
      </FieldGroup>

      {error ? (
        <FieldError role="alert" className="text-[0.8125rem] text-danger">
          Could not enqueue the task: {error}
        </FieldError>
      ) : null}

      <DialogFooter className="items-center">
        {invalid && isTaskDraftDirty(draft) ? (
          <span className="mr-auto text-xs text-subtle-foreground">{invalid}</span>
        ) : null}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={invalid !== null} aria-busy={submitting || undefined}>
          <Send aria-hidden="true" />
          {submitting ? "Enqueuing…" : "Enqueue task"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Success panel: the enqueued task, and its run once the worker starts it. */
export function NewTaskResult({
  task,
  runId,
  onCreateAnother,
  onNavigate,
}: {
  task: CreatedTask;
  /** Latest run for the task key, once the worker has picked it up. */
  runId?: number;
  onCreateAnother: () => void;
  /** Close the dialog when a link leaves it. */
  onNavigate: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div
        role="status"
        className="flex gap-2.5 rounded-lg border border-success-border bg-success-subtle px-3 py-2.5 text-[0.8125rem]"
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
      <DialogFooter>
        <Button variant="ghost" onClick={onCreateAnother}>
          Create another task
        </Button>
        <Button asChild variant={runId !== undefined ? "outline" : "default"}>
          <a href={RUNS_HASH} onClick={onNavigate}>
            View runs
          </a>
        </Button>
        {runId !== undefined ? (
          <Button asChild>
            <a href={runHash(runId)} onClick={onNavigate}>
              Open run #{runId}
            </a>
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

/** Polls for the run the worker records for a freshly enqueued task. */
function CreatedTaskPanel({
  task,
  onCreateAnother,
  onNavigate,
}: {
  task: CreatedTask;
  onCreateAnother: () => void;
  onNavigate: () => void;
}) {
  const params = new URLSearchParams({ taskKey: task.taskKey, limit: "1" });
  const { data } = usePoll<RunsResponse>(`/api/runs?${params}`, 3000);
  return (
    <NewTaskResult
      task={task}
      runId={data?.runs[0]?.id}
      onCreateAnother={onCreateAnother}
      onNavigate={onNavigate}
    />
  );
}

/** Body text when the workspace cannot take ad-hoc tasks, or null when it can. */
function workspaceProblem(
  workspace: WorkspaceResponse | null,
  error: string | null,
): string | null {
  if (error) return `Could not load the workspace: ${error}`;
  if (!workspace) return null;
  if (workspace.status !== "ok") {
    return `${workspace.error} Register a repository with \`devintern worker add-repo\`, then dispatch tasks here or with \`devintern worker add\`.`;
  }
  if (workspace.config.repos.length === 0) {
    return "No repositories are registered. Register a checkout with `devintern worker add-repo` first.";
  }
  return null;
}

/**
 * One open-to-close session of the dialog. Mounted only while the dialog is
 * open, so reopening starts a fresh draft and idempotency key.
 */
function NewTaskSession({ onClose }: { onClose: () => void }) {
  const workspace = usePoll<WorkspaceResponse>(WORKSPACE_URL, 30_000);
  const repos =
    workspace.data?.status === "ok" ? workspace.data.config.repos.map((repo) => repo.name) : [];
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedTask | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // The repo list arrives asynchronously; start the draft once it does.
  const current = draft ?? emptyTaskDraft(repos);
  const dirty = created === null && isTaskDraftDirty(current);

  const confirmDiscard = () => !dirty || window.confirm(DISCARD_PROMPT);
  const requestClose = () => {
    if (submitting) return;
    if (confirmDiscard()) onClose();
  };

  const submit = () => {
    setSubmitting(true);
    setError(null);
    void createTask({ ...current, idempotencyKey })
      .then((result) => {
        if (result.ok) setCreated(result.task);
        else setError(result.error);
      })
      .finally(() => setSubmitting(false));
  };

  const problem = workspaceProblem(workspace.data, workspace.error);

  return (
    <DialogContent
      showCloseButton={false}
      className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-y-auto p-5 sm:max-w-2xl"
      onOpenAutoFocus={(event) => {
        // The title also autofocuses when the form mounts after the repo list loads.
        if (!titleRef.current) return;
        event.preventDefault();
        titleRef.current.focus();
      }}
      // Never silently drop a draft (or abandon an in-flight submit).
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onInteractOutside={(event) => {
        if (submitting || dirty) event.preventDefault();
      }}
    >
      {/* Our own close button (not DialogContent's) so it can confirm a discard. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-3 right-3"
        onClick={requestClose}
        disabled={submitting}
        aria-label="Close"
      >
        <X aria-hidden="true" />
      </Button>
      <DialogHeader>
        <DialogTitle>New task</DialogTitle>
        <DialogDescription>
          Hand the worker a one-off task for a registered repository, like{" "}
          <code>devintern worker add</code>.
        </DialogDescription>
      </DialogHeader>

      {created ? (
        <CreatedTaskPanel
          task={created}
          onNavigate={onClose}
          onCreateAnother={() => {
            setCreated(null);
            setDraft(emptyTaskDraft(repos));
            setIdempotencyKey(newIdempotencyKey());
            setError(null);
          }}
        />
      ) : problem ? (
        <>
          <p className="text-[0.8125rem] text-muted-foreground">{problem}</p>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </>
      ) : workspace.data ? (
        <NewTaskForm
          repos={repos}
          draft={current}
          onDraftChange={setDraft}
          onSubmit={submit}
          onCancel={requestClose}
          submitting={submitting}
          error={error}
          titleRef={titleRef}
        />
      ) : (
        <div className="skeleton h-80 rounded-lg" />
      )}
    </DialogContent>
  );
}

/** "New task" dialog: enqueue an ad-hoc task (the dashboard's `devintern worker add`). */
export function NewTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <NewTaskSession onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}
