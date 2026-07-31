import { FolderOpen } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface WelcomeProps {
  onChooseProject: () => void;
  loading: boolean;
}

/** First-run screen: no project directory selected yet. */
export function Welcome({ onChooseProject, loading }: WelcomeProps) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">
        <span className="product-pm">devintern</span>
        <span className="product-sep">/</span>
        <span>pm</span>
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Turn Figma designs, error logs, or plain-language requirements into well-structured tracker
        issues. Choose a project directory containing a{" "}
        <code className="font-mono">.devintern-pm</code> config to get started.
      </p>
      <Button size="lg" onClick={onChooseProject} disabled={loading}>
        <FolderOpen data-icon="inline-start" />
        {loading ? "Loading…" : "Choose project directory"}
      </Button>
    </div>
  );
}

/** Banner shown when the chosen directory has no usable config. */
export function SetupBanner({ configError }: { configError: string | undefined }) {
  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertTitle>Project is not configured</AlertTitle>
      <AlertDescription>
        {configError}. Run <code className="font-mono">devpm init</code> in the project directory
        and fill in <code className="font-mono">.devintern-pm/.env</code>, then re-select the
        project.
      </AlertDescription>
    </Alert>
  );
}
