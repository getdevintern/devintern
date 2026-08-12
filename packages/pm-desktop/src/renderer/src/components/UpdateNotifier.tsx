/**
 * In-app update prompt: available → download progress → restart, with Later / retry.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatUpdateAvailableMessage } from "../../../shared/auto-update.ts";
import type { UpdateStatus } from "../../../shared/auto-update.ts";
import type { IpcResult } from "../../../shared/ipc-contract.ts";
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
import { qk } from "../queries/keys.ts";
import { useUpdateStatus } from "../queries/useUpdateStatus.ts";

export interface UpdateNotifierProps {
  /** True when any ticket has an agent/tracker operation in flight. */
  hasBusyWork: boolean;
}

function shortNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const trimmed = notes.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}…` : trimmed;
}

/** Whether the status should show the interruptive update dialog. */
export function shouldShowUpdateDialog(status: UpdateStatus): boolean {
  if (status.phase === "disabled") return false;
  // Background auto-download while snoozed stays quiet — the user said "Later"
  // and a non-modal progress banner would still feel like an interruption.
  // The "downloaded" (ready) state below is the action-needed surface and
  // is shown once even when previously snoozed.
  if (status.phase === "downloading") return !status.snoozed;
  if (status.phase === "error" && status.errorMessage) return true;
  if (status.phase === "downloaded") return !status.snoozed;
  if (status.phase === "available") return !status.snoozed;
  return false;
}

export function formatDownloadLabel(status: UpdateStatus): string {
  const percent = status.download?.percent;
  if (percent === undefined || Number.isNaN(percent)) return "Downloading update…";
  return `Downloading update… ${Math.floor(percent)}%`;
}

export function UpdateNotifier({ hasBusyWork }: UpdateNotifierProps) {
  const queryClient = useQueryClient();
  const { data: status } = useUpdateStatus();
  const [busyWarningOpen, setBusyWarningOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Clear any prior action error when a fresh status arrives from the shared
  // subscription (download progress, error recovery, etc.).
  useEffect(() => {
    setActionError(null);
  }, [status]);

  if (!status || !shouldShowUpdateDialog(status)) {
    return null;
  }

  const notes = shortNotes(status.releaseNotes);
  const versionLine =
    status.availableVersion != null
      ? formatUpdateAvailableMessage(status.availableVersion, status.currentVersion)
      : null;

  const run = (fn: () => Promise<IpcResult<UpdateStatus>>) => {
    setPending(true);
    setActionError(null);
    void fn().then((result) => {
      setPending(false);
      if (!result.ok) {
        setActionError(result.error.message ?? "Something went wrong");
        return;
      }
      // Keep the shared update-status cache in sync for other readers.
      queryClient.setQueryData(qk.updateStatus, result.value);
    });
  };

  const onInstallOrDownload = () => {
    if (status.phase === "downloaded") {
      if (hasBusyWork) {
        setBusyWarningOpen(true);
        return;
      }
      run(() => window.pm.installUpdate());
      return;
    }
    run(() => window.pm.downloadUpdate());
  };

  const onConfirmRestartAnyway = () => {
    setBusyWarningOpen(false);
    run(() => window.pm.installUpdate());
  };

  const primaryLabel =
    status.phase === "downloaded"
      ? "Restart & install"
      : status.phase === "downloading"
        ? "Downloading…"
        : status.phase === "error"
          ? "Retry"
          : "Download & install";

  const title =
    status.phase === "error"
      ? "Update failed"
      : status.phase === "downloading"
        ? "Downloading update"
        : status.phase === "downloaded"
          ? "Update ready"
          : "Update available";

  return (
    <>
      <div
        className="border-b border-border bg-muted/40 px-4 py-2"
        data-testid="update-notifier"
        role="status"
      >
        <Alert className="border-0 bg-transparent p-0 shadow-none">
          <AlertTitle data-testid="update-notifier-title">{title}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              {status.phase === "error" && status.errorMessage ? (
                <p data-testid="update-notifier-error">{status.errorMessage}</p>
              ) : status.phase === "downloading" ? (
                <p data-testid="update-notifier-progress">{formatDownloadLabel(status)}</p>
              ) : (
                <>
                  {versionLine && <p data-testid="update-notifier-version">{versionLine}</p>}
                  {notes && <p data-testid="update-notifier-notes">{notes}</p>}
                  {status.phase === "downloaded" && (
                    <p>
                      Restart to apply the update. Your settings and project preference are kept.
                    </p>
                  )}
                </>
              )}
              {actionError && (
                <p className="text-destructive" data-testid="update-notifier-action-error">
                  {actionError}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {status.phase === "error" ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending}
                    data-testid="update-notifier-retry"
                    onClick={() => {
                      if (status.availableVersion) {
                        run(() => window.pm.downloadUpdate());
                      } else {
                        run(() => window.pm.checkForUpdates());
                      }
                    }}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    data-testid="update-notifier-dismiss"
                    onClick={() => run(() => window.pm.dismissUpdateError())}
                  >
                    Dismiss
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending || status.phase === "downloading"}
                    data-testid="update-notifier-install"
                    onClick={onInstallOrDownload}
                  >
                    {primaryLabel}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending || status.phase === "downloading"}
                    data-testid="update-notifier-later"
                    onClick={() => run(() => window.pm.snoozeUpdate())}
                  >
                    Later
                  </Button>
                </>
              )}
            </div>
          </AlertDescription>
        </Alert>
      </div>

      <Dialog open={busyWarningOpen} onOpenChange={setBusyWarningOpen}>
        <DialogContent data-testid="update-busy-warning">
          <DialogHeader>
            <DialogTitle>Restart while work is in progress?</DialogTitle>
            <DialogDescription>
              An agent or tracker operation is still running. Restarting now will interrupt that
              work in the UI (it is not cancelled on the agent side). Your local settings are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBusyWarningOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="update-busy-restart-anyway"
              onClick={onConfirmRestartAnyway}
            >
              Restart anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
