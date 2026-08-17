import { CheckCircle2, CircleAlert, Loader2, RefreshCw, XCircle } from "lucide-react";
import { AnalyticsSettings } from "@/components/AnalyticsSettings";
import { Button } from "@/components/ui/button";
import type { ToolCheck, ToolValidation } from "../../../shared/tool-validation.ts";

interface RequiredToolsGateProps {
  result: ToolValidation | null;
  checking: boolean;
  /** IPC / unwrap error when the probe itself failed. */
  errorMessage?: string | null;
  onRecheck: () => void;
  onOpenDocs?: (url: string) => void;
}

function ToolRow({ tool, onOpenDocs }: { tool: ToolCheck; onOpenDocs?: (url: string) => void }) {
  return (
    <li
      className="rounded-md border px-3 py-2 text-left"
      data-testid={`required-tool-${tool.id}`}
      data-found={tool.found ? "true" : "false"}
    >
      <div className="flex items-start gap-2">
        {tool.found ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {tool.label}
            {tool.found && tool.detail ? (
              <span className="font-normal text-muted-foreground"> — {tool.detail}</span>
            ) : null}
            {!tool.found ? (
              <span className="font-normal text-destructive"> — not found</span>
            ) : null}
          </p>
          {!tool.found && tool.hint ? (
            <p className="text-xs text-muted-foreground">{tool.hint}</p>
          ) : null}
          {!tool.found && tool.docsUrl && onOpenDocs ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => {
                if (tool.docsUrl) onOpenDocs(tool.docsUrl);
              }}
            >
              Open install page
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * Blocking launch screen when Git or every supported agent CLI is missing.
 * Not shown when all required tools are present.
 */
export function RequiredToolsGate({
  result,
  checking,
  errorMessage = null,
  onRecheck,
  onOpenDocs,
}: RequiredToolsGateProps) {
  const pending = result === null && !errorMessage;

  return (
    <div
      className="relative flex h-screen flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="required-tools-gate"
      data-state={pending ? "checking" : errorMessage ? "error" : "missing"}
    >
      <div className="absolute top-3 right-3">
        <AnalyticsSettings />
      </div>
      <h1 className="text-2xl font-semibold">
        <span className="product-pm">devintern</span>
        <span className="product-sep">/</span>
        <span>pm</span>
      </h1>
      {pending ? (
        <>
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Loader2 className="size-6 animate-spin" />
          </div>
          <p
            className="max-w-md text-sm text-muted-foreground"
            data-testid="required-tools-checking"
          >
            Checking that Git and an agent CLI are installed…
          </p>
        </>
      ) : (
        <>
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <CircleAlert className="size-6" />
          </div>
          <div className="max-w-md space-y-2">
            <h2 className="text-base font-semibold" data-testid="required-tools-title">
              {errorMessage ? "Couldn't check required tools" : "Required tools are missing"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {errorMessage ??
                "Install the tools below, then check again. The app uses the same PATH it will use to run agents, including common GUI-launch locations."}
            </p>
          </div>
          {result ? (
            <ul className="flex w-full max-w-md flex-col gap-2" data-testid="required-tools-list">
              {result.tools
                .filter((tool) => tool.required)
                .map((tool) => (
                  <ToolRow key={tool.id} tool={tool} onOpenDocs={onOpenDocs} />
                ))}
            </ul>
          ) : null}
          {result && result.warnings.length > 0 ? (
            <p
              className="max-w-md text-xs text-muted-foreground"
              data-testid="required-tools-warnings"
            >
              {result.warnings.join(" ")}
            </p>
          ) : null}
          <Button
            size="lg"
            onClick={onRecheck}
            disabled={checking}
            data-testid="required-tools-recheck"
          >
            {checking ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {checking ? "Checking…" : "Check again"}
          </Button>
        </>
      )}
    </div>
  );
}
