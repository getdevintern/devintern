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

export function AboutDialog({ open, onOpenChange, version, onOpenWebsite }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="link"
            className="h-auto px-0"
            data-testid="about-dialog-website"
            onClick={() => onOpenWebsite(ABOUT_WEBSITE_URL)}
          >
            Visit website
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="about-dialog-close"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
