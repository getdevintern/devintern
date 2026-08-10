import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ABOUT_PRODUCT_NAME, ABOUT_WEBSITE_URL } from "../../../shared/about.ts";
import type { UpdateStatus } from "../../../shared/auto-update.ts";

export interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current app version; null while loading or if unavailable. */
  version: string | null;
  onOpenWebsite: (url: string) => void;
}

/** Sentinel passed when getAppVersion IPC fails (distinct from null = still loading). */
export const ABOUT_VERSION_UNAVAILABLE = "unavailable";

/** Format the version line shown in About (shared for tests). */
export function formatAboutVersion(version: string | null): string {
  if (version === null) return "Version …";
  if (version === ABOUT_VERSION_UNAVAILABLE) return "Version unavailable";
  return `Version ${version}`;
}

export function formatAboutUpdateResult(status: UpdateStatus): string {
  if (status.phase === "disabled") {
    return "Update checks are unavailable in development builds.";
  }
  if (status.phase === "available" && status.availableVersion) {
    return `Update available: ${status.availableVersion}`;
  }
  if (status.phase === "downloaded" && status.availableVersion) {
    return `Update ${status.availableVersion} ready to install — use the banner to restart.`;
  }
  if (status.phase === "downloading") {
    return "Downloading update…";
  }
  if (status.phase === "not-available") {
    return "You're up to date.";
  }
  if (status.phase === "error" && status.errorMessage) {
    return status.errorMessage;
  }
  if (status.phase === "checking") {
    return "Checking…";
  }
  return "Check complete.";
}

export function AboutDialog({ open, onOpenChange, version, onOpenWebsite }: AboutDialogProps) {
  const [checking, setChecking] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  const onCheckForUpdates = () => {
    setChecking(true);
    setUpdateMessage(null);
    void window.pm.checkForUpdates().then((result) => {
      setChecking(false);
      if (result.ok) {
        setUpdateMessage(formatAboutUpdateResult(result.value));
      } else {
        setUpdateMessage(result.error.message);
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setUpdateMessage(null);
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="about-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle data-testid="about-dialog-title">About {ABOUT_PRODUCT_NAME}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 pt-1 text-sm text-muted-foreground">
              <p data-testid="about-dialog-app-name">
                <span className="product-pm">devintern</span>
                <span className="product-sep">/</span>
                <span className="text-foreground">pm</span>
              </p>
              <p data-testid="about-dialog-version">{formatAboutVersion(version)}</p>
              <p>
                Multi-ticket AI task creation for your tracker. Visit the website for product
                information and documentation.
              </p>
              {updateMessage && <p data-testid="about-dialog-update-result">{updateMessage}</p>}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="link"
            className="h-auto px-0"
            data-testid="about-dialog-website"
            onClick={() => onOpenWebsite(ABOUT_WEBSITE_URL)}
          >
            Visit website
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="about-dialog-check-updates"
              disabled={checking}
              onClick={onCheckForUpdates}
            >
              {checking ? "Checking…" : "Check for updates"}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="about-dialog-close"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
