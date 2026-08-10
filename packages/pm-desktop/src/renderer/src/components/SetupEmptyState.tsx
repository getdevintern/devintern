import { FolderGit2, FolderOpen, GitPullRequest, Loader2, Settings2 } from "lucide-react";
import { AnalyticsSettings } from "@/components/AnalyticsSettings";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatProjectDirLabel } from "@/lib/format-project-dir-label";

interface WelcomeProps {
  /** Primary: Connect a GitHub repo into a managed clone. */
  onConnectGitHub: () => void;
  /** Advanced: open an existing local folder (eng path). */
  onChooseProject: () => void;
  loading: boolean;
  /** Eligible recent project directories (most recent first); null until first fetch. */
  recentProjects?: string[] | null;
  onOpenRecentProject?: (dir: string) => void;
}

/** First-run screen: no project directory selected yet. */
export function Welcome({
  onConnectGitHub,
  onChooseProject,
  loading,
  recentProjects = null,
  onOpenRecentProject,
}: WelcomeProps) {
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
        issues. Connect a GitHub repository — the app keeps a managed clone and you can finish PM
        setup entirely in the app.
      </p>
      <Button size="lg" onClick={onConnectGitHub} disabled={loading} data-testid="welcome-connect">
        {loading ? (
          <Loader2 className="animate-spin" data-icon="inline-start" />
        ) : (
          <GitPullRequest data-icon="inline-start" />
        )}
        {loading ? "Opening project…" : "Connect GitHub repository"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onChooseProject}
        disabled={loading}
        data-testid="welcome-choose"
      >
        <FolderOpen data-icon="inline-start" />
        Open existing folder
      </Button>
      {loading ? (
        <p className="max-w-sm text-xs text-muted-foreground" data-testid="welcome-loading-status">
          Syncing git and loading tracker settings…
        </p>
      ) : null}
      <div
        className="mt-2 flex w-full max-w-md flex-col items-stretch gap-2 text-left"
        data-testid="welcome-recent-projects"
      >
        <p className="text-center text-xs font-medium text-muted-foreground">Recent projects</p>
        {recentProjects === null ? null : recentProjects.length === 0 ? (
          <p
            className="rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground"
            data-testid="recent-projects-empty"
          >
            No recent projects yet. Connect a GitHub repo or open a PM-initialized folder.
          </p>
        ) : (
          recentProjects.map((dir) => (
            <Button
              key={dir}
              type="button"
              variant="outline"
              className="h-auto min-h-9 justify-start px-3 py-2"
              disabled={loading || !onOpenRecentProject}
              title={dir}
              onClick={() => onOpenRecentProject?.(dir)}
            >
              <FolderOpen data-icon="inline-start" />
              <span className="min-w-0 flex-1 truncate text-left">
                {formatProjectDirLabel(dir, recentProjects)}
              </span>
            </Button>
          ))
        )}
      </div>
    </div>
  );
}

interface InvalidProjectBannerProps {
  onChangeProject: () => void;
}

/**
 * Banner when the folder is not a suitable project (not inside a git repo).
 * Distinct from {@link SetupBanner} — next action is pick a different folder.
 */
export function InvalidProjectBanner({ onChangeProject }: InvalidProjectBannerProps) {
  return (
    <Alert
      variant="destructive"
      className="rounded-none border-x-0 border-t-0"
      data-testid="invalid-project-banner"
    >
      <AlertTitle>Not a valid project folder</AlertTitle>
      <AlertDescription>
        This folder is not part of a git repository. Choose a project that is connected to git so
        the app can manage issues in a real project context.
      </AlertDescription>
      <AlertAction>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-destructive/40 text-destructive hover:bg-destructive/10"
          onClick={onChangeProject}
          data-testid="invalid-project-banner-cta"
        >
          <FolderOpen data-icon="inline-start" />
          Choose different folder
        </Button>
      </AlertAction>
    </Alert>
  );
}

interface InvalidProjectEmptyStateProps {
  onChangeProject: () => void;
}

/** Main-area empty state for a selected folder that fails the git suitability check. */
export function InvalidProjectEmptyState({ onChangeProject }: InvalidProjectEmptyStateProps) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-8 text-center"
      data-testid="invalid-project-empty"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <FolderGit2 className="size-6" />
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="text-base font-semibold">This folder is not ready for PM</h2>
        <p className="text-sm text-muted-foreground">
          Pick a directory inside a git repository. Once the folder is a valid project, you can set
          up PM here if it is not configured yet.
        </p>
      </div>
      <Button size="lg" onClick={onChangeProject} data-testid="invalid-project-choose">
        <FolderOpen data-icon="inline-start" />
        Choose project directory
      </Button>
    </section>
  );
}

interface SetupBannerProps {
  onSetup: () => void;
  /** True when another fully configured tracker can be selected from the header. */
  canRecoverViaTrackerSwitch?: boolean;
}

/** Banner shown when the folder is a git project but has no usable PM config. */
export function SetupBanner({ onSetup, canRecoverViaTrackerSwitch = false }: SetupBannerProps) {
  return (
    <Alert
      variant="destructive"
      className="rounded-none border-x-0 border-t-0"
      data-testid="setup-banner"
    >
      <AlertTitle>Project needs PM setup</AlertTitle>
      <AlertDescription>
        {canRecoverViaTrackerSwitch
          ? "Another tracker looks ready — switch using the control in the header, or set up this project."
          : "This is a valid git project, but PM is not configured yet. Connect a task tracker to create and manage issues."}
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

interface SetupEmptyStateProps {
  onSetup: () => void;
}

/**
 * Main-area empty state for a git project that still needs `.devintern-pm` setup.
 * Distinct from {@link NoTicketsEmptyState} — next action is init, not open a ticket.
 */
export function SetupEmptyState({ onSetup }: SetupEmptyStateProps) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-8 text-center"
      data-testid="setup-empty"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Settings2 className="size-6" />
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="text-base font-semibold">Finish PM setup to create tickets</h2>
        <p className="text-sm text-muted-foreground">
          This folder is a git project, but it has no PM configuration yet. Connect a task tracker
          once — credentials stay in the project — then you can open tickets here.
        </p>
      </div>
      <Button size="lg" onClick={onSetup} data-testid="setup-empty-cta">
        <Settings2 data-icon="inline-start" />
        Set up project
      </Button>
    </section>
  );
}
