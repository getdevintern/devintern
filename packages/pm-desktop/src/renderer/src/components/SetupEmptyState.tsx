import { FolderOpen, Settings2 } from "lucide-react";
import { AnalyticsSettings } from "@/components/AnalyticsSettings";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface WelcomeProps {
  onChooseProject: () => void;
  loading: boolean;
}

/** First-run screen: no project directory selected yet. */
export function Welcome({ onChooseProject, loading }: WelcomeProps) {
  return (
    <div
      className="relative flex h-screen flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="welcome-screen"
    >
      <div className="absolute top-3 right-3">
        <AnalyticsSettings />
      </div>
      <h1 className="text-2xl font-semibold">
        <span className="product-pm">devintern</span>
        <span className="product-sep">/</span>
        <span>pm</span>
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Turn Figma designs, error logs, or plain-language requirements into well-structured tracker
        issues. Choose a project directory — if it is not configured yet, you can finish setup
        entirely in the app.
      </p>
      <Button size="lg" onClick={onChooseProject} disabled={loading} data-testid="welcome-choose">
        <FolderOpen data-icon="inline-start" />
        {loading ? "Loading…" : "Choose project directory"}
      </Button>
    </div>
  );
}

interface SetupBannerProps {
  onSetup: () => void;
  /** True when another fully configured tracker can be selected from the header. */
  canRecoverViaTrackerSwitch?: boolean;
}

/** Banner shown when the chosen directory has no usable config. */
export function SetupBanner({ onSetup, canRecoverViaTrackerSwitch = false }: SetupBannerProps) {
  return (
    <Alert
      variant="destructive"
      className="rounded-none border-x-0 border-t-0"
      data-testid="setup-banner"
    >
      <AlertTitle>Project is not configured</AlertTitle>
      <AlertDescription>
        {canRecoverViaTrackerSwitch
          ? "Another tracker looks ready — switch using the control in the header, or set up this project."
          : "Connect a task tracker to create and manage issues from this app."}
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-destructive/40 text-destructive hover:bg-destructive/10"
          onClick={onSetup}
          data-testid="setup-banner-cta"
        >
          <Settings2 data-icon="inline-start" />
          Set up project
        </Button>
      </AlertAction>
    </Alert>
  );
}
