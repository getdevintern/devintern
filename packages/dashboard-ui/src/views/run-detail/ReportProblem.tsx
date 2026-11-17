import { useReducer, useState } from "react";
import type { Dispatch, ReactNode } from "react";
import { Bug, CircleCheck, ExternalLink, Info, Save, Send, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { previewRunReport, submitReport } from "@/lib/api";
import type { ReportPreview, RunRecord, RunStatus } from "@/lib/api";
import { formatDuration } from "@/lib/utils";
import {
  canPreview,
  canSend,
  INITIAL_REPORT_FLOW,
  isReportBusy,
  isReportDraftDirty,
  reportFlowReducer,
} from "./report-flow";
import type { ReportFlowAction, ReportFlowState, SavedResult, SentResult } from "./report-flow";

export const REPORT_DOCS_URL = "https://devintern.com/docs/code/reporting-bugs";

/** Runs whose outcome is a failure; others get a secondary report action. */
const FAILED_STATUSES: RunStatus[] = ["failed", "escalated", "abandoned"];

const DISCARD_PROMPT = "Discard this bug report draft?";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Step 1: guidance, title, description, identifier opt-in. */
export function ComposeStep({
  state,
  dispatch,
  onPreview,
  onCancel,
}: {
  state: ReportFlowState;
  dispatch: Dispatch<ReportFlowAction>;
  onPreview: () => void;
  onCancel: () => void;
}) {
  const { draft, phase } = state;
  const busy = phase.step === "compose" && phase.busy;
  const error = phase.step === "compose" ? phase.error : undefined;
  return (
    <form
      className="flex min-h-0 flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onPreview();
      }}
    >
      <div
        role="note"
        className="flex gap-2.5 rounded-lg border border-info-border bg-info-subtle px-3 py-2.5 text-xs/relaxed text-foreground"
      >
        <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
        <p>
          Missing credentials, usage limits and failed verification checks are configuration issues,
          not bugs.{" "}
          <a
            href={REPORT_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-4"
          >
            See the docs
          </a>
          .
        </p>
      </div>
      <FieldGroup>
        <Field data-disabled={busy || undefined}>
          <FieldLabel htmlFor="report-title">Title</FieldLabel>
          <Input
            id="report-title"
            className="h-8"
            value={draft.title}
            maxLength={200}
            required
            autoFocus
            autoComplete="off"
            disabled={busy}
            placeholder="Worker marks the run failed after the PR opened"
            onChange={(event) => dispatch({ type: "edit", draft: { title: event.target.value } })}
          />
        </Field>
        <Field data-disabled={busy || undefined}>
          <FieldLabel htmlFor="report-description">
            What did you expect, and what happened?
          </FieldLabel>
          <Textarea
            id="report-description"
            className="h-36 max-h-[40vh] resize-y overflow-y-auto [field-sizing:fixed]"
            value={draft.description}
            required
            disabled={busy}
            placeholder="Expected… Instead… Steps to reproduce…"
            aria-describedby="report-description-warning"
            onChange={(event) =>
              dispatch({ type: "edit", draft: { description: event.target.value } })
            }
          />
          <FieldDescription id="report-description-warning" className="flex items-start gap-1.5">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span>
              Do not paste secrets, credentials, or customer data. Known credentials are masked, but
              redaction cannot recognize everything.
            </span>
          </FieldDescription>
        </Field>
        <Field orientation="horizontal" data-disabled={busy || undefined}>
          <Checkbox
            id="report-share-identifiers"
            checked={draft.shareIdentifiers}
            disabled={busy}
            onCheckedChange={(checked) =>
              dispatch({ type: "edit", draft: { shareIdentifiers: checked === true } })
            }
          />
          <FieldContent>
            <FieldLabel htmlFor="report-share-identifiers">Share identifiers</FieldLabel>
            <FieldDescription>
              Includes the task key and repository slug. Off by default: both are masked.
            </FieldDescription>
          </FieldContent>
        </Field>
      </FieldGroup>
      {error ? (
        <FieldError role="alert" className="text-[0.8125rem] text-danger">
          {error}
        </FieldError>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canPreview(state)} aria-busy={busy || undefined}>
          {busy ? "Preparing preview…" : "Preview report"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <li>
      <span className="text-success" aria-hidden="true">
        ✓
      </span>{" "}
      {children}
    </li>
  );
}

function AttachmentList({ preview }: { preview: ReportPreview }) {
  const { environment, run, logs, evidenceCount, identifiersShared } = preview.attachments;
  return (
    <ul className="space-y-1 text-[0.8125rem]">
      <Check>
        Environment: devintern {environment.cliVersion} ({environment.installKind}),{" "}
        {environment.os}/{environment.arch}
        {environment.harness ? `, harness ${environment.harness}` : ""}
        {environment.tracker ? `, tracker ${environment.tracker}` : ""}
        {environment.sandbox ? `, sandbox ${environment.sandbox}` : ""}
        {environment.ci ? ", automated" : ""}
      </Check>
      {run ? (
        <Check>
          Run #{run.id ?? "?"}: {run.status}
          {run.failedStep ? ` at ${run.failedStep}` : ""}
          {run.durationMs !== undefined ? `, ${formatDuration(run.durationMs)}` : ""}
          {`, ${run.stageCount} stage(s)`}
          {run.hasReason ? ", failure reason" : ""}
        </Check>
      ) : null}
      {logs.map((log) => (
        <Check key={log.source}>
          Log <code className="font-mono">{log.source}</code>: {log.lines} lines,{" "}
          {formatBytes(log.bytes)}
          {log.truncated ? " (tail)" : ""}
        </Check>
      ))}
      {evidenceCount > 0 ? <Check>Evidence: {evidenceCount} item(s)</Check> : null}
      <li>
        <span className="text-muted-foreground" aria-hidden="true">
          •
        </span>{" "}
        Identifiers: {identifiersShared ? "task key and repository slug included" : "masked"}
      </li>
    </ul>
  );
}

/** Step 2: exactly what will be sent, contact email, and the explicit Send. */
export function PreviewStep({
  state,
  dispatch,
  onSend,
}: {
  state: ReportFlowState;
  dispatch: Dispatch<ReportFlowAction>;
  onSend: () => void;
}) {
  const { phase } = state;
  if (phase.step !== "preview") return null;
  const { preview, busy, error } = phase;
  return (
    <form
      className="flex min-h-0 flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend(state)) onSend();
      }}
    >
      <section className="space-y-1">
        <h3 className="text-xs font-medium text-subtle-foreground">Title</h3>
        <p className="text-[0.875rem] [overflow-wrap:anywhere]">{preview.title}</p>
      </section>
      <section className="space-y-1">
        <h3 className="text-xs font-medium text-subtle-foreground">
          Description (after redaction)
        </h3>
        <p className="max-h-40 overflow-y-auto text-[0.8125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {preview.description}
        </p>
      </section>
      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-subtle-foreground">Attached</h3>
        <AttachmentList preview={preview} />
      </section>
      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-subtle-foreground">Never sent</h3>
        <p className="text-[0.8125rem] text-muted-foreground">
          <span className="text-danger" aria-hidden="true">
            ✗
          </span>{" "}
          {preview.omitted.join(", ")}
        </p>
      </section>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-[0.8125rem]">
          Show full payload ({formatBytes(preview.bytes)})
        </summary>
        <pre className="max-h-80 overflow-auto border-t border-border px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {JSON.stringify(preview.payload, null, 2)}
        </pre>
      </details>
      {preview.contactRequired ? (
        <Field data-disabled={busy || undefined}>
          <FieldLabel htmlFor="report-email">Contact email</FieldLabel>
          <Input
            id="report-email"
            type="email"
            className="h-8 sm:max-w-xs"
            value={state.email}
            required
            autoComplete="email"
            disabled={busy}
            placeholder="you@example.com"
            onChange={(event) => dispatch({ type: "email", email: event.target.value })}
          />
          <FieldDescription>
            You are not signed in, so we need an address to follow up. It is sent as the report
            contact alongside the payload above. Run <code>devintern login</code> to report from
            your account instead.
          </FieldDescription>
        </Field>
      ) : (
        <p className="text-xs text-muted-foreground">
          Signed in: follow-up goes through your DevIntern account.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Destination: <code className="font-mono">{preview.destination}</code>. A copy is saved in
        your local report history.
      </p>
      {error ? (
        <FieldError role="alert" className="text-[0.8125rem] text-danger">
          {error}
        </FieldError>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => dispatch({ type: "back" })}
        >
          Back to edit
        </Button>
        <Button type="submit" disabled={!canSend(state)} aria-busy={busy || undefined}>
          <Send aria-hidden="true" />
          {busy ? "Sending…" : "Send report"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Step 3: the report id, or where the unsent report was saved. */
export function ResultStep({
  result,
  onRetry,
  onClose,
}: {
  result: SentResult | SavedResult;
  onRetry: () => void;
  onClose: () => void;
}) {
  if (result.status === "sent") {
    return (
      <div className="flex flex-col gap-4">
        <div
          role="status"
          className="flex gap-2.5 rounded-lg border border-success-border bg-success-subtle px-3 py-2.5 text-[0.8125rem]"
        >
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              Sent report <code className="font-mono">{result.shortId}</code>. Thank you.
            </p>
            {result.receipt ? (
              <p className="text-muted-foreground">
                Receipt <code className="font-mono">{result.receipt}</code>. Keep it to check the
                status without signing in.
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          {result.url ? (
            <Button asChild variant="outline">
              <a href={result.url} target="_blank" rel="noreferrer">
                View report
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div
        role="status"
        className="flex gap-2.5 rounded-lg border border-warning-border bg-warning-subtle px-3 py-2.5 text-[0.8125rem]"
      >
        <Save className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">The report was not sent, but it was saved locally.</p>
          <p className="text-danger [overflow-wrap:anywhere]">{result.error}</p>
          {result.authExpired ? (
            <p className="text-muted-foreground">
              Your sign-in may have expired. Run <code>devintern login</code> and retry.
            </p>
          ) : null}
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-subtle-foreground">Retry from a terminal:</p>
        <code className="block rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs break-all">
          {result.retryCommand}
        </code>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onRetry}>Try again</Button>
      </DialogFooter>
    </div>
  );
}

/** The dialog body for the current step. */
export function ReportDialogBody({
  state,
  dispatch,
  onPreview,
  onSend,
  onClose,
}: {
  state: ReportFlowState;
  dispatch: Dispatch<ReportFlowAction>;
  onPreview: () => void;
  onSend: () => void;
  /** Close request; the session confirms a discard when the draft is dirty. */
  onClose: () => void;
}) {
  const { phase } = state;
  if (phase.step === "compose") {
    return (
      <ComposeStep state={state} dispatch={dispatch} onPreview={onPreview} onCancel={onClose} />
    );
  }
  if (phase.step === "preview") {
    return <PreviewStep state={state} dispatch={dispatch} onSend={onSend} />;
  }
  return <ResultStep result={phase.result} onRetry={onSend} onClose={onClose} />;
}

const STEP_TITLES: Record<ReportFlowState["phase"]["step"], string> = {
  compose: "Report a problem",
  preview: "Review what will be sent",
  sent: "Report sent",
  saved: "Report saved locally",
};

/**
 * One open-to-close session of the dialog. Mounted only while the dialog is
 * open, so a confirmed close discards the draft and reopening starts fresh.
 */
function ReportSession({ run, onClose }: { run: RunRecord; onClose: () => void }) {
  const [state, dispatch] = useReducer(reportFlowReducer, INITIAL_REPORT_FLOW);
  const busy = isReportBusy(state);
  const dirty = isReportDraftDirty(state);

  const requestClose = () => {
    if (busy) return;
    if (!dirty || window.confirm(DISCARD_PROMPT)) onClose();
  };

  async function handlePreview(): Promise<void> {
    if (!canPreview(state)) return;
    dispatch({ type: "previewStart" });
    try {
      dispatch({ type: "previewDone", preview: await previewRunReport(run.id, state.draft) });
    } catch (cause: unknown) {
      dispatch({
        type: "previewFailed",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function handleSend(): Promise<void> {
    const { phase } = state;
    const preview =
      phase.step === "preview" ? phase.preview : phase.step === "saved" ? phase.preview : null;
    if (!preview) return;
    dispatch({ type: "sendStart" });
    try {
      const email = preview.contactRequired ? state.email.trim() : undefined;
      dispatch({ type: "sendDone", result: await submitReport(preview.previewId, email) });
    } catch (cause: unknown) {
      dispatch({
        type: "sendFailed",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const { step } = state.phase;
  return (
    <DialogContent
      showCloseButton={false}
      className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-y-auto p-5 sm:max-w-2xl"
      // Never silently drop a draft (or abandon an in-flight request).
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onInteractOutside={(event) => {
        if (busy || dirty) event.preventDefault();
      }}
    >
      {/* Our own close button (not DialogContent's) so it can confirm a discard. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-3 right-3"
        onClick={requestClose}
        disabled={busy}
        aria-label="Close"
      >
        <X aria-hidden="true" />
      </Button>
      <DialogHeader>
        <DialogTitle>{STEP_TITLES[step]}</DialogTitle>
        <DialogDescription>
          {step === "compose"
            ? `File a DevIntern bug report for run #${run.id}. You will see exactly what is sent before anything leaves this machine.`
            : step === "preview"
              ? "Nothing has been sent yet. This is the redacted payload Send will submit."
              : `Run #${run.id}`}
        </DialogDescription>
      </DialogHeader>
      <ReportDialogBody
        state={state}
        dispatch={dispatch}
        onPreview={() => void handlePreview()}
        onSend={() => void handleSend()}
        onClose={requestClose}
      />
    </DialogContent>
  );
}

/** "Report a problem" action and dialog for one run. */
export function ReportProblem({ run }: { run: RunRecord }) {
  const [open, setOpen] = useState(false);
  if (run.status === "in_progress") return null;
  const failed = FAILED_STATUSES.includes(run.status);
  return (
    <>
      <Button
        variant={failed ? "outline" : "ghost"}
        onClick={() => setOpen(true)}
        title={failed ? undefined : "Report incorrect behavior in this run"}
      >
        <Bug />
        Report a problem
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <ReportSession run={run} onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}
