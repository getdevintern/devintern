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
  type EnvPromptStep,
} from "@getdevintern/pm/init-shared";
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

type WizardStep =
  | "loading"
  | "overwrite"
  | "reuse"
  | "tracker"
  | "credentials"
  | "probing"
  | "probe-failed"
  | "saving"
  | "error";

interface ProjectSetupWizardProps {
  projectDir: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (status: ProjectStatus) => void;
}

function isSecretKey(key: string): boolean {
  return /TOKEN|PAT|API_KEY|PASSWORD|SECRET/i.test(key);
}

function firstStep(inspect: ProjectInitInspect): WizardStep {
  if (inspect.configExists) return "overwrite";
  if (inspect.reusableFromCode) return "reuse";
  return "tracker";
}

function stepAfterOverwrite(inspect: ProjectInitInspect): WizardStep {
  if (inspect.reusableFromCode) return "reuse";
  return "tracker";
}

function trackerDocs(trackers: PmTrackerInfo[], trackerId: string): string | undefined {
  return trackers.find((t) => t.id === trackerId)?.docsUrl;
}

function needsProbe(trackers: PmTrackerInfo[], trackerId: string): boolean {
  return trackers.find((t) => t.id === trackerId)?.needsCredentials === true;
}

export function ProjectSetupWizard({
  projectDir,
  open,
  onOpenChange,
  onComplete,
}: ProjectSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>("loading");
  const [inspect, setInspect] = useState<ProjectInitInspect | null>(null);
  const [trackerId, setTrackerId] = useState("markdown");
  const [values, setValues] = useState<Record<string, string>>({});
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep("loading");
    setInspect(null);
    setTrackerId("markdown");
    setValues({});
    setOverwriteConfirmed(false);
    setProbeError(null);
    setFormError(null);
    setFatalError(null);

    void window.pm.inspectProjectInit(projectDir).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setFatalError(result.error.message);
        setStep("error");
        return;
      }
      setInspect(result.value);
      const next = firstStep(result.value);
      if (next === "tracker" && result.value.trackers[0]) {
        setTrackerId(result.value.trackers[0].id);
      }
      setStep(next);
    });

    return () => {
      cancelled = true;
    };
  }, [open, projectDir]);

  const steps: EnvPromptStep[] = useMemo(
    () => (trackerId ? (PM_TRACKER_SETUP[trackerId] ?? []) : []),
    [trackerId],
  );

  const docsUrl = inspect ? trackerDocs(inspect.trackers, trackerId) : undefined;

  const setValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const applyReusable = (existing: ExistingTrackerConfig) => {
    setTrackerId(existing.trackerId);
    setValues({ ...existing.values });
    setStep("credentials");
  };

  const goCredentialsFromTracker = () => {
    setValues({});
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
    const result = await window.pm.initializeProject({
      projectDir,
      trackerId,
      values,
      // Only true after the overwrite step — cancel there never reaches finish.
      overwrite: overwriteConfirmed,
    });
    if (!result.ok) {
      if (result.error.code === "already_exists") {
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
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle>Set up project</DialogTitle>
          <DialogDescription className="min-w-0 break-words" title={projectDir}>
            Connect a task tracker for{" "}
            <span className="font-mono text-xs break-all">{projectDir}</span>
          </DialogDescription>
        </DialogHeader>

        {step === "loading" && (
          <p className="text-sm text-muted-foreground" data-testid="setup-loading">
            Checking project…
          </p>
        )}

        {step === "overwrite" && inspect && (
          <div className="min-w-0 space-y-3" data-testid="setup-overwrite">
            <Alert variant="destructive">
              <AlertTitle>Configuration already exists</AlertTitle>
              <AlertDescription>
                This project is already set up. Continuing replaces the current settings. Cancel
                leaves them unchanged.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="setup-overwrite-continue"
                onClick={() => {
                  setOverwriteConfirmed(true);
                  setStep(stepAfterOverwrite(inspect));
                }}
              >
                Overwrite and continue
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "reuse" && inspect?.reusableFromCode && (
          <div className="min-w-0 space-y-3" data-testid="setup-reuse">
            <p className="text-sm text-muted-foreground">
              Found existing{" "}
              {PM_TRACKER_NAMES[inspect.reusableFromCode.trackerId] ??
                inspect.reusableFromCode.trackerId}{" "}
              credentials from Devintern Code in this project. Reuse them?
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                data-testid="setup-reuse-decline"
                onClick={() => {
                  setTrackerId(inspect.trackers[0]?.id ?? "markdown");
                  setValues({});
                  setStep("tracker");
                }}
              >
                Set up manually
              </Button>
              <Button
                type="button"
                data-testid="setup-reuse-accept"
                onClick={() => applyReusable(inspect.reusableFromCode!)}
              >
                Reuse
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "tracker" && inspect && (
          <div className="space-y-3" data-testid="setup-tracker">
            <Label htmlFor="setup-tracker-select">Task tracker</Label>
            <NativeSelect
              id="setup-tracker-select"
              value={trackerId}
              onChange={(e) => setTrackerId(e.target.value)}
              data-testid="setup-tracker-select"
            >
              {inspect.trackers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
            </NativeSelect>
            {docsUrl && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() => void window.pm.openExternal(docsUrl)}
                data-testid="setup-docs-link"
              >
                Setup guide
                <ExternalLink className="size-3" />
              </button>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="setup-tracker-continue"
                onClick={goCredentialsFromTracker}
              >
                Continue
              </Button>
            </DialogFooter>
          </div>
        )}

        {(step === "credentials" || step === "probe-failed") && (
          <div className="space-y-3" data-testid="setup-credentials">
            {docsUrl && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() => void window.pm.openExternal(docsUrl)}
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
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        ({hints.join("; ")})
                      </span>
                    )}
                  </Label>
                  {link && (
                    <button
                      type="button"
                      className="mb-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      onClick={() => void window.pm.openExternal(link)}
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
                    onChange={(e) => setValue(field.key, e.target.value)}
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
            {step === "probe-failed" && probeError && (
              <Alert variant="destructive" data-testid="setup-probe-error">
                <AlertTitle>Connection check failed</AlertTitle>
                <AlertDescription>{probeError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="flex-wrap gap-2">
              {step === "probe-failed" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="setup-probe-retry"
                    onClick={() => void finish(false)}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="setup-probe-skip"
                    onClick={() => void finish(true)}
                  >
                    Skip validation
                  </Button>
                  <Button type="button" onClick={() => setStep("credentials")}>
                    Edit values
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep(inspect?.reusableFromCode ? "reuse" : "tracker")}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    data-testid="setup-finish"
                    onClick={() => void finish(false)}
                  >
                    {needsProbe(inspect?.trackers ?? [], trackerId)
                      ? "Validate and finish"
                      : "Finish setup"}
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        )}

        {step === "probing" && (
          <p className="text-sm text-muted-foreground" data-testid="setup-probing">
            Checking the connection…
          </p>
        )}

        {step === "saving" && (
          <p className="text-sm text-muted-foreground" data-testid="setup-saving">
            Writing configuration…
          </p>
        )}

        {step === "error" && (
          <div className="space-y-3" data-testid="setup-error">
            <Alert variant="destructive">
              <AlertTitle>Setup failed</AlertTitle>
              <AlertDescription>{fatalError ?? "Unknown error"}</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setFatalError(null);
                  setStep(inspect ? firstStep(inspect) : "loading");
                }}
              >
                Try again
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
