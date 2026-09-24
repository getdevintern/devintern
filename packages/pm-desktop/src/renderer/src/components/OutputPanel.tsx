import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, RotateCcw, Send } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import type { Phase } from "../state/app-store.ts";
import { isBusy } from "../state/app-store.ts";
import { useActiveTicket, useComposerBusy } from "../state/selectors.ts";
import { useTicketWorkspacesStore } from "../state/ticket-workspaces-store.ts";
import type {
  CreateTaskResponse,
  IpcError,
  StoryDraft,
  SubtaskDraft,
  SubtaskOutcome,
} from "../../../shared/ipc-contract.ts";
import { CodeDiscoveryCard } from "./CodeDiscoveryCard.tsx";

const MarkdownDescriptionEditor = lazy(async () => {
  const mod = await import("./MarkdownDescriptionEditor.tsx");
  return { default: mod.MarkdownDescriptionEditor };
});

interface OutputPanelProps {
  onEdit: (editPrompt: string) => void;
  onCreate: () => void;
  onCreateSubtasks: () => void;
  onOpenUrl: (url: string) => void;
  /** Soft Code discovery tip shown after a successful create. */
  showCodeDiscovery?: boolean;
  onLearnMoreCode?: (url: string) => void;
  onDismissCodeDiscovery?: () => void;
  codeDiscoveryDismissError?: string | null;
}

/** Auto-scrolling monospace log of live agent output. */
function AgentStream({ log }: { log: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log]);
  if (!log) return null;
  return (
    <pre
      ref={ref}
      className="max-h-56 overflow-y-auto rounded-md bg-foreground/90 p-3 font-mono text-[0.7rem]/relaxed whitespace-pre-wrap text-background"
    >
      {log}
    </pre>
  );
}

function WorkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/** In-flight phase indicators. Renders nothing for non-working phases. */
function PhaseIndicators({ phase, issueType }: { phase: Phase; issueType: string }) {
  switch (phase) {
    case "generating":
      return <WorkingIndicator label="Generating story…" />;
    case "editing":
      return <WorkingIndicator label="Applying your edit…" />;
    case "decomposing":
      return <WorkingIndicator label="Decomposing into subtasks…" />;
    case "creating":
      return <WorkingIndicator label={`Creating ${issueType}…`} />;
    case "creating-subtasks":
      return <WorkingIndicator label="Creating subtasks…" />;
    default:
      return null;
  }
}

/** Phases during which streaming agent output should be visible. */
function isAgentStreamPhase(phase: Phase): boolean {
  return phase === "generating" || phase === "editing" || phase === "decomposing";
}

/** Phases during which the editable draft preview is shown. */
function isDraftPhase(phase: Phase): boolean {
  return phase === "preview" || phase === "editing" || phase === "creating";
}

function OutputErrorAlert({ error, onDismiss }: { error: IpcError; onDismiss: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>
        {error.code}: {error.message}
      </AlertTitle>
      <AlertDescription>
        {error.detail && (
          <Collapsible>
            <CollapsibleTrigger className="cursor-pointer text-xs underline underline-offset-2">
              Raw agent output
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1 max-h-48 overflow-y-auto font-mono text-[0.7rem] whitespace-pre-wrap">
                {error.detail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
        <Button variant="outline" size="sm" className="mt-2" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );
}

interface DraftEditorSectionProps {
  draft: StoryDraft;
  issueType: string;
  decompose: boolean;
  busy: boolean;
  editPrompt: string;
  onEditPromptChange: (value: string) => void;
  onTitleChange: (summary: string) => void;
  onDescriptionChange: (description: string) => void;
  onSubmitEdit: () => void;
  onCreate: () => void;
}

function DraftEditorSection({
  draft,
  issueType,
  decompose,
  busy,
  editPrompt,
  onEditPromptChange,
  onTitleChange,
  onDescriptionChange,
  onSubmitEdit,
  onCreate,
}: DraftEditorSectionProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Input
        className="h-9 shrink-0 text-base font-semibold"
        value={draft.summary}
        onChange={(e) => onTitleChange(e.target.value)}
        disabled={busy}
      />
      <div className="draft-description-shell min-h-0 flex-1 overflow-hidden rounded-md border bg-card text-sm">
        <Suspense
          fallback={
            <div className="flex h-full min-h-40 items-center justify-center gap-2 p-4 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading editor…
            </div>
          }
        >
          <MarkdownDescriptionEditor
            markdown={draft.description}
            onChange={onDescriptionChange}
            readOnly={busy}
          />
        </Suspense>
      </div>
      <div className="flex shrink-0 gap-2">
        <Input
          placeholder="Request changes… (e.g. add acceptance criteria for mobile)"
          value={editPrompt}
          onChange={(e) => onEditPromptChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmitEdit()}
          disabled={busy}
        />
        <Button variant="outline" onClick={onSubmitEdit} disabled={!editPrompt.trim() || busy}>
          <Send data-icon="inline-start" />
          Edit
        </Button>
        <Button onClick={onCreate} disabled={busy}>
          {decompose ? `Create ${issueType} + subtasks` : `Create ${issueType}`}
        </Button>
      </div>
    </div>
  );
}

interface SubtaskReviewProps {
  subtasks: SubtaskDraft[];
  selectedSubtasks: Set<number>;
  busy: boolean;
  onToggleSubtask: (index: number) => void;
  onCreateSubtasks: () => void;
  onSkipSubtasks: () => void;
}

function SubtaskReview({
  subtasks,
  selectedSubtasks,
  busy,
  onToggleSubtask,
  onCreateSubtasks,
  onSkipSubtasks,
}: SubtaskReviewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suggested subtasks</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {subtasks.map((subtask, index) => (
          <label
            key={`${subtask.summary}\0${subtask.description ?? ""}`}
            className="flex items-start gap-2 rounded-md border p-2 text-sm"
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={selectedSubtasks.has(index)}
              onChange={() => onToggleSubtask(index)}
              disabled={busy}
            />
            <span>
              <span className="font-medium">{subtask.summary}</span>
              {subtask.description && (
                <span className="block text-xs text-muted-foreground">
                  {subtask.description.slice(0, 200)}
                </span>
              )}
            </span>
          </label>
        ))}
        <div className="mt-1 flex gap-2">
          <Button onClick={onCreateSubtasks} disabled={busy || selectedSubtasks.size === 0}>
            Create {selectedSubtasks.size} subtask
            {selectedSubtasks.size === 1 ? "" : "s"}
          </Button>
          <Button variant="ghost" onClick={onSkipSubtasks} disabled={busy}>
            Skip
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface CreatedTaskCardProps {
  created: CreateTaskResponse;
  subtaskOutcomes: SubtaskOutcome[] | null;
  onOpenUrl: (url: string) => void;
  onRestart: () => void;
  showCodeDiscovery: boolean;
  onLearnMoreCode?: (url: string) => void;
  onDismissCodeDiscovery?: () => void;
  codeDiscoveryDismissError: string | null;
}

function CreatedTaskCard({
  created,
  subtaskOutcomes,
  onOpenUrl,
  onRestart,
  showCodeDiscovery,
  onLearnMoreCode,
  onDismissCodeDiscovery,
  codeDiscoveryDismissError,
}: CreatedTaskCardProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-secondary" />
            Task created: {created.key}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Button
            variant="link"
            className="h-auto justify-start p-0 text-left break-all whitespace-normal"
            onClick={() => onOpenUrl(created.url)}
          >
            <ExternalLink data-icon="inline-start" />
            {created.url}
          </Button>
          {created.epicLinkError && (
            <p className="text-xs text-destructive">
              Epic link failed: {created.epicLinkError} (task was still created)
            </p>
          )}
          {created.labelsApplyError && (
            <p className="text-xs text-destructive">
              Labels failed: {created.labelsApplyError} (task was still created)
            </p>
          )}
          {created.attachmentsUploaded > 0 && (
            <p className="text-xs text-muted-foreground">
              Uploaded {created.attachmentsUploaded} attachment
              {created.attachmentsUploaded === 1 ? "" : "s"}
            </p>
          )}
          {created.attachmentErrors && created.attachmentErrors.length > 0 && (
            <p className="text-xs text-destructive">
              Attachment upload failed: {created.attachmentErrors.join("; ")} (task was still
              created)
            </p>
          )}
          {subtaskOutcomes && (
            <ul className="flex flex-col gap-1 text-xs">
              {subtaskOutcomes.map((outcome) => (
                <li key={outcome.key ?? `${outcome.subtask.summary}\0${outcome.error ?? ""}`}>
                  {outcome.error ? (
                    <span className="text-destructive">
                      ✗ {outcome.subtask.summary}: {outcome.error}
                    </span>
                  ) : (
                    <span>
                      ✓ {outcome.key}: {outcome.subtask.summary}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="outline" size="sm" onClick={onRestart}>
              <RotateCcw data-icon="inline-start" />
              New task
            </Button>
          </div>
        </CardContent>
      </Card>
      {showCodeDiscovery && onLearnMoreCode && onDismissCodeDiscovery && (
        <CodeDiscoveryCard
          variant="post-create"
          onLearnMore={onLearnMoreCode}
          onDismiss={onDismissCodeDiscovery}
          dismissError={codeDiscoveryDismissError}
        />
      )}
    </>
  );
}

export function OutputPanel({
  onEdit,
  onCreate,
  onCreateSubtasks,
  onOpenUrl,
  showCodeDiscovery = false,
  onLearnMoreCode,
  onDismissCodeDiscovery,
  codeDiscoveryDismissError = null,
}: OutputPanelProps) {
  const [editPrompt, setEditPrompt] = useState("");
  const activeTicket = useActiveTicket();
  const externallyBusy = useComposerBusy();
  const applyOutputAction = useTicketWorkspacesStore((s) => s.applyOutputAction);
  // OutputPanel only mounts when a ticket is active, but guard defensively.
  if (!activeTicket) return null;
  const output = activeTicket.output;
  const issueType = activeTicket.composer.issueType;
  const decompose = activeTicket.composer.decompose;
  const busy = externallyBusy || isBusy(output.phase);
  const ticketId = activeTicket.id;
  const onTitleChange = (summary: string) =>
    applyOutputAction(ticketId, { type: "draft-title-changed", summary });
  const onDescriptionChange = (description: string) =>
    applyOutputAction(ticketId, { type: "draft-description-changed", description });
  const onToggleSubtask = (index: number) =>
    applyOutputAction(ticketId, { type: "subtask-toggled", index });
  const onSkipSubtasks = () => applyOutputAction(ticketId, { type: "subtasks-skipped" });
  const onRestart = () => applyOutputAction(ticketId, { type: "restarted" });
  const onDismissError = () => applyOutputAction(ticketId, { type: "error-dismissed" });

  const submitEdit = () => {
    if (!editPrompt.trim() || busy) return;
    onEdit(editPrompt);
    setEditPrompt("");
  };

  if (output.phase === "idle") {
    return (
      <section className="flex min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Fill in the form and hit Generate — the story preview appears here.
        </p>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <PhaseIndicators phase={output.phase} issueType={issueType} />

      {isAgentStreamPhase(output.phase) ? <AgentStream log={output.agentLog} /> : null}

      {output.error ? <OutputErrorAlert error={output.error} onDismiss={onDismissError} /> : null}

      {output.draft && isDraftPhase(output.phase) ? (
        <DraftEditorSection
          draft={output.draft}
          issueType={issueType}
          decompose={decompose}
          busy={busy}
          editPrompt={editPrompt}
          onEditPromptChange={setEditPrompt}
          onTitleChange={onTitleChange}
          onDescriptionChange={onDescriptionChange}
          onSubmitEdit={submitEdit}
          onCreate={onCreate}
        />
      ) : null}

      {output.phase === "subtask-review" ? (
        <SubtaskReview
          subtasks={output.subtasks}
          selectedSubtasks={output.selectedSubtasks}
          busy={busy}
          onToggleSubtask={onToggleSubtask}
          onCreateSubtasks={onCreateSubtasks}
          onSkipSubtasks={onSkipSubtasks}
        />
      ) : null}

      {output.phase === "done" && output.created ? (
        <CreatedTaskCard
          created={output.created}
          subtaskOutcomes={output.subtaskOutcomes}
          onOpenUrl={onOpenUrl}
          onRestart={onRestart}
          showCodeDiscovery={showCodeDiscovery}
          onLearnMoreCode={onLearnMoreCode}
          onDismissCodeDiscovery={onDismissCodeDiscovery}
          codeDiscoveryDismissError={codeDiscoveryDismissError}
        />
      ) : null}
    </section>
  );
}
