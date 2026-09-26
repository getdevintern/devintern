/**
 * In-app project setup wizard — ports `devpm init` into the desktop UI.
 *
 * Tracker steps, docs links, env rendering, probes, and file writes all come
 * from `@getdevintern/pm/init` (shared with the CLI wizard).
 */

import { useEffect, useMemo, useState } from "react";
import {
  PM_TRACKER_NAMES,
  PM_TRACKER_SETUP,
  missingRequiredPmFields,
  stepLink,
} from "@getdevintern/pm/init-shared";
import type { EnvPromptStep } from "@getdevintern/pm/init-shared";
import { ExternalLink } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type {
  ExistingTrackerConfig,
  PmTrackerInfo,
  ProjectInitInspect,
  ProjectStatus,
} from "../../../shared/ipc-contract.ts";
import { useInspectProjectInit } from "../queries/useInspectProjectInit.ts";
import {
  firstWizardStep,
  prefilledValues,
  stepAfterOverwrite,
} from "./ProjectSetupWizard.helpers.ts";
import type { WizardMode, WizardStep } from "./ProjectSetupWizard.helpers.ts";

export { type WizardMode } from "./ProjectSetupWizard.helpers.ts";

interface ProjectSetupWizardProps {
  projectDir: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (status: ProjectStatus) => void;
  /**
   * `"update"` opens the wizard in post-init mode: it skips the overwrite /
   * reuse steps, starts at the tracker picker (prefilled with the active
   * tracker and existing credential values), and merges credentials into the
   * existing `.env` instead of overwriting it. Defaults to `"init"`.
   */
  mode?: WizardMode;
}

function isSecretKey(key: string): boolean {
  return /TOKEN|PAT|API_KEY|PASSWORD|SECRET/i.test(key);
}

function trackerDocs(trackers: PmTrackerInfo[], trackerId: string): string | undefined {
  return trackers.find((t) => t.id === trackerId)?.docsUrl;
}

function needsProbe(trackers: PmTrackerInfo[], trackerId: string): boolean {
  return trackers.find((t) => t.id === trackerId)?.needsCredentials === true;
}

function WizardHeader({ mode, projectDir }: { mode: WizardMode; projectDir: string }) {
  return (
    <DialogHeader className="min-w-0 pr-6">
      <DialogTitle>{mode === "update" ? "Change task tracker" : "Set up project"}</DialogTitle>
      <DialogDescription className="min-w-0 break-words" title={projectDir}>
        {mode === "update" ? (
          <>
            Update tracker settings for{" "}
            <span className="font-mono text-xs break-all">{projectDir}</span>. Other trackers and
            settings are kept.
          </>
        ) : (
          <>
            Connect a task tracker for{" "}
            <span className="font-mono text-xs break-all">{projectDir}</span>
          </>
        )}
      </DialogDescription>
    </DialogHeader>
  );
}

function OverwriteStep({ onCancel, onContinue }: { onCancel: () => void; onContinue: () => void }) {
  return (
    <div className="min-w-0 space-y-3" data-testid="setup-overwrite">
      <Alert variant="destructive">
        <AlertTitle>Configuration already exists</AlertTitle>
        <AlertDescription>
          This project is already set up. Continuing replaces the current settings. Cancel leaves
          them unchanged.
        </AlertDescription>
      </Alert>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" data-testid="setup-overwrite-continue" onClick={onContinue}>
          Overwrite and continue
        </Button>
      </DialogFooter>
    </div>
  );
}

interface ReuseStepProps {
  reusable: ExistingTrackerConfig;
  onManual: () => void;
  onReuse: (reusable: ExistingTrackerConfig) => void;
}

function ReuseStep({ reusable, onManual, onReuse }: ReuseStepProps) {
  return (
    <div className="min-w-0 space-y-3" data-testid="setup-reuse">
      <p className="text-sm text-muted-foreground">
        Found existing {PM_TRACKER_NAMES[reusable.trackerId] ?? reusable.trackerId} credentials from
        Devintern Code in this project. Reuse them?
      </p>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          data-testid="setup-reuse-decline"
          onClick={onManual}
        >
          Set up manually
        </Button>
        <Button type="button" data-testid="setup-reuse-accept" onClick={() => onReuse(reusable)}>
          Reuse
        </Button>
      </DialogFooter>
    </div>
  );
}

interface TrackerStepProps {
  trackers: PmTrackerInfo[];
  trackerId: string;
  docsUrl?: string;
  onSelect: (trackerId: string) => void;
  onOpenDocs: (url: string) => void;
  onCancel: () => void;
  onContinue: () => void;
}

function TrackerStep({
  trackers,
  trackerId,
  docsUrl,
  onSelect,
  onOpenDocs,
  onCancel,
  onContinue,
}: TrackerStepProps) {
  return (
    <div className="space-y-3" data-testid="setup-tracker">
      <Label htmlFor="setup-tracker-select">Task tracker</Label>
      <NativeSelect
        id="setup-tracker-select"
        value={trackerId}
        onChange={(e) => onSelect(e.target.value)}
        data-testid="setup-tracker-select"
      >
        {trackers.map((t) => (
          <option key={t.id} value={t.id}>
            {t.displayName}
          </option>
        ))}
      </NativeSelect>
      {docsUrl && (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          onClick={() => onOpenDocs(docsUrl)}
          data-testid="setup-docs-link"
        >
          Setup guide
          <ExternalLink className="size-3" />
        </button>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" data-testid="setup-tracker-continue" onClick={onContinue}>
          Continue
        </Button>
      </DialogFooter>
    </div>
  );
}

interface CredentialsStepProps {
  trackerId: string;
  steps: EnvPromptStep[];
  values: Record<string, string>;
  docsUrl?: string;
  formError: string | null;
  probeError: string | null;
  isProbeFailed: boolean;
  finishLabel: string;
  onChange: (key: string, value: string) => void;
  onOpenDocs: (url: string) => void;
  onBack: () => void;
  onEditValues: () => void;
  onFinish: (skipProbe: boolean) => void;
}

function CredentialsStep({
  trackerId,
  steps,
  values,
  docsUrl,
  formError,
  probeError,
  isProbeFailed,
  finishLabel,
  onChange,
  onOpenDocs,
  onBack,
  onEditValues,
  onFinish,
}: CredentialsStepProps) {
  return (
    <div className="space-y-3" data-testid="setup-credentials">
      {docsUrl && (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          onClick={() => onOpenDocs(docsUrl)}
        >
          {PM_TRACKER_NAMES[trackerId] ?? trackerId} setup guide
          <ExternalLink className="size-3" />
        </button>
      )}
      {trackerId === "markdown" && (
        <p className="text-sm text-muted-foreground">
          No credentials needed for the markdown tracker.
        </p>
      )}
      {steps.map((field) => {
        const link = stepLink(field, values);
        const hints: string[] = [];
        if (field.example) hints.push(`e.g. ${field.example}`);
        if (field.defaultValue) hints.push("leave blank for default");
        else if (field.optional) hints.push("optional");
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`setup-field-${field.key}`}>
              {field.label}
              {hints.length > 0 && (
                <span className="font-normal text-muted-foreground"> ({hints.join("; ")})</span>
              )}
            </Label>
            {link && (
              <button
                type="button"
                className="mb-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() => onOpenDocs(link)}
                data-testid={`setup-link-${field.key}`}
              >
                Create / open
                <ExternalLink className="size-3" />
              </button>
            )}
            <Input
              id={`setup-field-${field.key}`}
              type={isSecretKey(field.key) ? "password" : "text"}
              value={values[field.key] ?? ""}
              placeholder={field.defaultValue ?? field.example}
              onChange={(e) => onChange(field.key, e.target.value)}
              autoComplete="off"
              data-testid={`setup-field-${field.key}`}
            />
          </div>
        );
      })}
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      {isProbeFailed && probeError && (
        <Alert variant="destructive" data-testid="setup-probe-error">
          <AlertTitle>Connection check failed</AlertTitle>
          <AlertDescription>{probeError}</AlertDescription>
        </Alert>
      )}
      <DialogFooter className="flex-wrap gap-2">
        {isProbeFailed ? (
          <>
            <Button
              type="button"
              variant="outline"
              data-testid="setup-probe-retry"
              onClick={() => onFinish(false)}
            >
              Retry
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="setup-probe-skip"
              onClick={() => onFinish(true)}
            >
              Skip validation
            </Button>
            <Button type="button" onClick={onEditValues}>
              Edit values
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onBack}>
              Back
            </Button>
            <Button type="button" data-testid="setup-finish" onClick={() => onFinish(false)}>
              {finishLabel}
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

interface ErrorStepProps {
  message: string | null;
  onClose: () => void;
  onRetry: () => void;
}

function ErrorStep({ message, onClose, onRetry }: ErrorStepProps) {
  return (
    <div className="space-y-3" data-testid="setup-error">
      <Alert variant="destructive">
        <AlertTitle>Setup failed</AlertTitle>
        <AlertDescription>{message ?? "Unknown error"}</AlertDescription>
      </Alert>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </DialogFooter>
    </div>
  );
}

function StatusParagraph({ testId, children }: { testId: string; children: string }) {
  return (
    <p className="text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

export function ProjectSetupWizard({
  projectDir,
  open,
  onOpenChange,
  onComplete,
  mode = "init",
}: ProjectSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>("loading");
  const [inspect, setInspect] = useState<ProjectInitInspect | null>(null);
  const [trackerId, setTrackerId] = useState("markdown");
  const [values, setValues] = useState<Record<string, string>>({});
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const inspectQuery = useInspectProjectInit(projectDir, open);

  // Reset wizard state each time the dialog opens (the query refetches via
  // staleTime: 0 so the inspect is always fresh on open).
  useEffect(() => {
    if (!open) return;
    setStep("loading");
    setInspect(null);
    setTrackerId("markdown");
    setValues({});
    setOverwriteConfirmed(false);
    setProbeError(null);
    setFormError(null);
    setFatalError(null);
  }, [open]);

  const inspectErrorMessage = inspectQuery.error?.message;

  // Drive step transitions from the shared inspect query result.
  useEffect(() => {
    if (!open) return;
    if (inspectQuery.isError) {
      setFatalError(inspectErrorMessage ?? "Failed to inspect project");
      setStep("error");
      return;
    }
    if (!inspectQuery.data) return;
    setInspect(inspectQuery.data);
    const next = firstWizardStep(inspectQuery.data, mode);
    if (next === "tracker") {
      // Update mode: start on the active tracker with its existing values.
      // Init mode: default to the first tracker (markdown) with blank values.
      const startTracker =
        mode === "update" && inspectQuery.data.currentEnv.TASK_TRACKER
          ? inspectQuery.data.currentEnv.TASK_TRACKER
          : (inspectQuery.data.trackers[0]?.id ?? "markdown");
      setTrackerId(startTracker);
      if (mode === "update") {
        setValues(prefilledValues(inspectQuery.data, startTracker));
      }
    }
    setStep(next);
  }, [open, inspectQuery.data, inspectQuery.isError, inspectErrorMessage, mode]);

  const steps: EnvPromptStep[] = useMemo(
    () => (trackerId ? (PM_TRACKER_SETUP[trackerId] ?? []) : []),
    [trackerId],
  );

  const docsUrl = inspect ? trackerDocs(inspect.trackers, trackerId) : undefined;
  const probeRequired = needsProbe(inspect?.trackers ?? [], trackerId);
  const finishLabel =
    mode === "update"
      ? probeRequired
        ? "Validate and switch tracker"
        : "Switch tracker"
      : probeRequired
        ? "Validate and finish"
        : "Finish setup";
  const backStep: WizardStep =
    mode === "update" ? "tracker" : inspect?.reusableFromCode ? "reuse" : "tracker";

  const setValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const applyReusable = (existing: ExistingTrackerConfig) => {
    setTrackerId(existing.trackerId);
    setValues({ ...existing.values });
    setStep("credentials");
  };

  const selectTracker = (nextTrackerId: string) => {
    setTrackerId(nextTrackerId);
    setFormError(null);
    // In update mode, swap in the existing env values for the chosen tracker
    // so the user edits known credentials instead of retyping them.
    if (mode === "update" && inspect) {
      setValues(prefilledValues(inspect, nextTrackerId));
    } else {
      setValues({});
    }
  };

  const goCredentialsFromTracker = () => {
    setFormError(null);
    setStep("credentials");
  };

  const validateForm = (): boolean => {
    const missingKeys = missingRequiredPmFields(trackerId, values);
    if (missingKeys.length > 0) {
      const labels = missingKeys.map((key) => {
        const step = steps.find((s) => s.key === key);
        return step?.label ?? key;
      });
      setFormError(`Required: ${labels.join(", ")}`);
      return false;
    }
    setFormError(null);
    return true;
  };

  const finish = async (skipProbe: boolean) => {
    if (!inspect) return;
    if (!validateForm()) {
      setStep("credentials");
      return;
    }

    if (!skipProbe && needsProbe(inspect.trackers, trackerId)) {
      setStep("probing");
      setProbeError(null);
      const probed = await window.pm.probeTrackerConnection(trackerId, values);
      if (!probed.ok) {
        setProbeError(probed.error.message);
        setStep("probe-failed");
        return;
      }
      if (!probed.value.ok) {
        setProbeError(probed.value.message);
        setStep("probe-failed");
        return;
      }
    }

    setStep("saving");
    setFatalError(null);
    const result =
      mode === "update"
        ? await window.pm.updateProjectTracker({
            projectDir,
            trackerId,
            values,
          })
        : await window.pm.initializeProject({
            projectDir,
            trackerId,
            values,
            // Only true after the overwrite step — cancel there never reaches finish.
            overwrite: overwriteConfirmed,
          });
    if (!result.ok) {
      if (mode === "init" && result.error.code === "already_exists") {
        setFatalError(result.error.message);
        setStep("overwrite");
        return;
      }
      setFatalError(result.error.message);
      setStep("error");
      return;
    }
    onComplete(result.value);
    onOpenChange(false);
  };

  const openExternal = (url: string) => void window.pm.openExternal(url);
  const busy = step === "loading" || step === "probing" || step === "saving";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-x-hidden overflow-y-auto"
        data-testid="project-setup-wizard"
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <WizardHeader mode={mode} projectDir={projectDir} />

        {step === "loading" ? (
          <StatusParagraph testId="setup-loading">Checking project…</StatusParagraph>
        ) : null}

        {step === "overwrite" && inspect ? (
          <OverwriteStep
            onCancel={() => onOpenChange(false)}
            onContinue={() => {
              setOverwriteConfirmed(true);
              setStep(stepAfterOverwrite(inspect));
            }}
          />
        ) : null}

        {step === "reuse" && inspect?.reusableFromCode ? (
          <ReuseStep
            reusable={inspect.reusableFromCode}
            onManual={() => {
              setTrackerId(inspect.trackers[0]?.id ?? "markdown");
              setValues({});
              setStep("tracker");
            }}
            onReuse={applyReusable}
          />
        ) : null}

        {step === "tracker" && inspect ? (
          <TrackerStep
            trackers={inspect.trackers}
            trackerId={trackerId}
            docsUrl={docsUrl}
            onSelect={selectTracker}
            onOpenDocs={openExternal}
            onCancel={() => onOpenChange(false)}
            onContinue={goCredentialsFromTracker}
          />
        ) : null}

        {step === "credentials" || step === "probe-failed" ? (
          <CredentialsStep
            trackerId={trackerId}
            steps={steps}
            values={values}
            docsUrl={docsUrl}
            formError={formError}
            probeError={probeError}
            isProbeFailed={step === "probe-failed"}
            finishLabel={finishLabel}
            onChange={setValue}
            onOpenDocs={openExternal}
            onBack={() => setStep(backStep)}
            onEditValues={() => setStep("credentials")}
            onFinish={finish}
          />
        ) : null}

        {step === "probing" ? (
          <StatusParagraph testId="setup-probing">Checking the connection…</StatusParagraph>
        ) : null}

        {step === "saving" ? (
          <StatusParagraph testId="setup-saving">Writing configuration…</StatusParagraph>
        ) : null}

        {step === "error" ? (
          <ErrorStep
            message={fatalError}
            onClose={() => onOpenChange(false)}
            onRetry={() => {
              setFatalError(null);
              setStep(inspect ? firstWizardStep(inspect, mode) : "loading");
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
