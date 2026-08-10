import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, RotateCcw, Send } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { isBusy, type OutputState } from "../state/app-store.ts";
import { CodeDiscoveryCard } from "./CodeDiscoveryCard.tsx";

const MarkdownDescriptionEditor = lazy(async () => {
  const mod = await import("./MarkdownDescriptionEditor.tsx");
  return { default: mod.MarkdownDescriptionEditor };
});

interface OutputPanelProps {
  output: OutputState;
  issueType: string;
  decompose: boolean;
  /** Extra busy (e.g. harness/tracker/project switch) beyond the ticket phase. */
  busy?: boolean;
  onTitleChange: (summary: string) => void;
  onDescriptionChange: (description: string) => void;
  onEdit: (editPrompt: string) => void;
  onCreate: () => void;
  onToggleSubtask: (index: number) => void;
  onCreateSubtasks: () => void;
  onSkipSubtasks: () => void;
  onRestart: () => void;
  onDismissError: () => void;
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

export function OutputPanel({
  output,
  issueType,
  decompose,
  busy: externallyBusy = false,
  onTitleChange,
  onDescriptionChange,
  onEdit,
  onCreate,
  onToggleSubtask,
  onCreateSubtasks,
  onSkipSubtasks,
  onRestart,
  onDismissError,
  onOpenUrl,
  showCodeDiscovery = false,
  onLearnMoreCode,
  onDismissCodeDiscovery,
  codeDiscoveryDismissError = null,
}: OutputPanelProps) {
  const [editPrompt, setEditPrompt] = useState("");
  const busy = externallyBusy || isBusy(output.phase);

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
      {output.phase === "generating" && <WorkingIndicator label="Generating story…" />}
      {output.phase === "editing" && <WorkingIndicator label="Applying your edit…" />}
      {output.phase === "decomposing" && <WorkingIndicator label="Decomposing into subtasks…" />}
      {output.phase === "creating" && <WorkingIndicator label={`Creating ${issueType}…`} />}
      {output.phase === "creating-subtasks" && <WorkingIndicator label="Creating subtasks…" />}

      {(output.phase === "generating" ||
        output.phase === "editing" ||
        output.phase === "decomposing") && <AgentStream log={output.agentLog} />}

      {output.error && (
        <Alert variant="destructive">
          <AlertTitle>
            {output.error.code}: {output.error.message}
          </AlertTitle>
          <AlertDescription>
            {output.error.detail && (
              <Collapsible>
                <CollapsibleTrigger className="cursor-pointer text-xs underline underline-offset-2">
                  Raw agent output
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 max-h-48 overflow-y-auto font-mono text-[0.7rem] whitespace-pre-wrap">
                    {output.error.detail}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
            <Button variant="outline" size="sm" className="mt-2" onClick={onDismissError}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {output.draft &&
        (output.phase === "preview" ||
          output.phase === "editing" ||
          output.phase === "creating") && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <Input
              className="h-9 shrink-0 text-base font-semibold"
              value={output.draft.summary}
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
                  markdown={output.draft.description}
                  onChange={onDescriptionChange}
                  readOnly={busy}
                />
              </Suspense>
            </div>
            <div className="flex shrink-0 gap-2">
              <Input
                placeholder="Request changes… (e.g. add acceptance criteria for mobile)"
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitEdit()}
                disabled={busy}
              />
              <Button variant="outline" onClick={submitEdit} disabled={!editPrompt.trim() || busy}>
                <Send data-icon="inline-start" />
                Edit
              </Button>
              <Button onClick={onCreate} disabled={busy}>
                {decompose ? `Create ${issueType} + subtasks` : `Create ${issueType}`}
              </Button>
            </div>
          </div>
        )}

      {output.phase === "subtask-review" && (
        <Card>
          <CardHeader>
            <CardTitle>Suggested subtasks</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {output.subtasks.map((subtask, index) => (
              <label key={index} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  checked={output.selectedSubtasks.has(index)}
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
              <Button
                onClick={onCreateSubtasks}
                disabled={busy || output.selectedSubtasks.size === 0}
              >
                Create {output.selectedSubtasks.size} subtask
                {output.selectedSubtasks.size === 1 ? "" : "s"}
              </Button>
              <Button variant="ghost" onClick={onSkipSubtasks} disabled={busy}>
                Skip
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {output.phase === "done" && output.created && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-secondary" />
                Task created: {output.created.key}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <Button
                variant="link"
                className="h-auto justify-start p-0 text-left break-all whitespace-normal"
                onClick={() => onOpenUrl(output.created!.url)}
              >
                <ExternalLink data-icon="inline-start" />
                {output.created.url}
              </Button>
              {output.created.epicLinkError && (
                <p className="text-xs text-destructive">
                  Epic link failed: {output.created.epicLinkError} (task was still created)
                </p>
              )}
              {output.created.labelsApplyError && (
                <p className="text-xs text-destructive">
                  Labels failed: {output.created.labelsApplyError} (task was still created)
                </p>
              )}
              {output.created.attachmentsUploaded > 0 && (
                <p className="text-xs text-muted-foreground">
                  Uploaded {output.created.attachmentsUploaded} attachment
                  {output.created.attachmentsUploaded === 1 ? "" : "s"}
                </p>
              )}
              {output.created.attachmentErrors && output.created.attachmentErrors.length > 0 && (
                <p className="text-xs text-destructive">
                  Attachment upload failed: {output.created.attachmentErrors.join("; ")} (task was
                  still created)
                </p>
              )}
              {output.subtaskOutcomes && (
                <ul className="flex flex-col gap-1 text-xs">
                  {output.subtaskOutcomes.map((outcome, i) => (
                    <li key={i}>
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
      )}
    </section>
  );
}
