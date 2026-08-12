import type { ReactNode } from "react";
import {
  ChevronsUpDown,
  CloudDownload,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Settings2,
} from "lucide-react";
import { AnalyticsSettings } from "@/components/AnalyticsSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatProjectDirLabel } from "@/lib/format-project-dir-label";
import { cn } from "@/lib/utils";
import { useProjectStore } from "../state/project-store.ts";
import { useAnyTicketBusy } from "../state/selectors.ts";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";
import {
  canUpdateProjectFromRemote,
  projectGitSyncLabel,
  shouldShowUpdateFromRemote,
} from "../../../shared/project-git-sync.ts";

interface ProjectBarProps {
  /** Primary: Connect a GitHub repository → managed clone. */
  onConnectGitHub?: () => void;
  /** Advanced: open an existing local folder. */
  onChangeProject: () => void;
  /** Eligible recent project directories (most recent first). */
  recentProjects?: string[];
  onOpenRecentProject?: (dir: string) => void;
  /** Refresh the recent list when the directory menu opens. */
  onRecentMenuOpenChange?: (open: boolean) => void;
  onSwitchTracker: (trackerId: string) => void;
  onSwitchProjectKey: (projectKey: string) => void;
  onSwitchHarness: (harnessName: string) => void;
  /**
   * Open the in-app wizard in update mode so the user can add a new tracker or
   * reconfigure credentials for an existing one (post-init PM settings).
   */
  onChangeTrackerSettings?: () => void;
  /** Fetch + ff-only pull when clean or soft-dirty. */
  onUpdateFromRemote?: () => void;
  /** After removing a managed clone from Settings. */
  onProjectRemoved?: () => void;
}

/** Shared shell so interactive buttons and read-only badges read as one pill row. */
const contextChipSizeClassName = "h-6 gap-1 rounded-full px-2 text-xs/relaxed font-medium";
const contextChipClassName = cn(
  contextChipSizeClassName,
  "border-border bg-input/20 text-foreground dark:bg-input/30",
);

/** Compact role caption shared by interactive and read-only context chips. */
function ContextRoleLabel({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-[0.65rem] font-normal text-muted-foreground">{children}</span>
  );
}

function formatProjectLabel(name: string, key: string): string {
  return name === key ? key : `${name} (${key})`;
}

function activeProjectLabel(status: ProjectStatus): string | null {
  const key = status.defaultProjectKey;
  if (key) {
    const match = status.projects?.find((p) => p.key === key);
    if (match) return formatProjectLabel(match.name, match.key);
    return key;
  }
  // No persisted default yet — if the tracker only has one project, show it.
  const only = status.projects?.length === 1 ? status.projects[0] : undefined;
  return only ? formatProjectLabel(only.name, only.key) : null;
}

export function ProjectBar({
  onConnectGitHub,
  onChangeProject,
  recentProjects = [],
  onOpenRecentProject,
  onRecentMenuOpenChange,
  onSwitchTracker,
  onSwitchProjectKey,
  onSwitchHarness,
  onChangeTrackerSettings,
  onUpdateFromRemote,
  onProjectRemoved,
}: ProjectBarProps) {
  const status = useProjectStore((s) => s.status);
  const switching = useProjectStore((s) => s.loadingProject);
  const updatingFromRemote = useProjectStore((s) => s.updatingFromRemote);
  const agentRunning = useAnyTicketBusy();
  // ProjectBar only mounts once a project is loaded, but guard defensively.
  if (!status) return null;
  const trackers = status.configuredTrackers ?? [];
  const trackerLabel =
    status.activeTrackerDisplayName ?? status.backendName ?? status.activeTrackerId;
  // Offer a menu when multiple trackers are ready, when the active one failed
  // to load but another configured tracker can take over, or when the user can
  // open the update wizard (post-init PM settings entry point).
  const activeTrackerConfigured = trackers.some((t) => t.id === status.activeTrackerId);
  // Tracker/project controls only apply to git-connected folders.
  const gitReady = status.isGitRepository;
  const canChangeTrackerSettings = Boolean(onChangeTrackerSettings) && gitReady;
  const canSwitchTracker =
    gitReady && (trackers.length > 1 || !activeTrackerConfigured || canChangeTrackerSettings);
  const projectLabel = activeProjectLabel(status);
  // Prefer GitHub remote label for managed (and any bound) remotes.
  const remoteLabel = status.projectBinding?.remote;
  // Include the active dir so its label disambiguates against recent siblings.
  const dirLabelAmong = recentProjects.includes(status.projectDir)
    ? recentProjects
    : [status.projectDir, ...recentProjects];
  const dirLabel = remoteLabel ?? formatProjectDirLabel(status.projectDir, dirLabelAmong);
  const projects = status.projects ?? [];
  // Offer the header switcher whenever the tracker returned multiple projects.
  // Project choice lives here (not in the composer) so it persists as the
  // session default via onSwitchProjectKey.
  const canSwitchProject =
    gitReady &&
    Boolean(status.supportsProjectSwitch) &&
    status.configured &&
    projects.length > 1 &&
    !status.projectsError;
  const projectValue = projectLabel ?? "Select project";
  const harnessLabel = status.harnessDisplayName;
  const harnesses = status.availableHarnesses ?? [];
  // Show the switcher whenever multiple harnesses are installed; busy states
  // keep the dropdown mounted and disable it (same idea as the tracker chip).
  const canSwitchHarness = harnesses.length > 1;
  const contextBusy = switching || agentRunning || updatingFromRemote;
  const busyTitle = agentRunning
    ? "Unavailable while an agent is running"
    : updatingFromRemote
      ? "Getting latest changes…"
      : switching
        ? "Unavailable while switching"
        : null;
  const changeProjectTitle =
    busyTitle ??
    `${remoteLabel ? `${remoteLabel} — ` : ""}${status.projectDir} — Connect GitHub repository or open folder`;
  const trackerTitle = busyTitle ?? "Switch task tracker";
  const projectTitle = busyTitle ?? "Switch project";
  const harnessTitle = busyTitle ?? "Switch agent harness";
  const gitSync = status.gitSync;
  const branchName = gitSync?.branch;
  const syncLabel = gitSync ? projectGitSyncLabel(gitSync) : null;
  const showUpdate = Boolean(onUpdateFromRemote) && shouldShowUpdateFromRemote(gitSync);
  const updateEnabled = canUpdateProjectFromRemote(gitSync) && !contextBusy;
  const updateTitle =
    busyTitle ??
    (gitSync?.kind === "skipped_dirty"
      ? gitSync.message
      : (gitSync?.message ?? "Get the latest changes from the online repository"));
  const ProjectIcon = remoteLabel ? GitPullRequest : FolderOpen;

  return (
    <header className="flex min-w-0 items-center gap-2 border-b bg-card px-3 py-2">
      <span className="shrink-0 text-sm font-semibold">
        <span className="product-pm">devintern</span>
        <span className="product-sep">/</span>
        <span>pm</span>
      </span>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) onRecentMenuOpenChange?.(true);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 max-w-full"
            disabled={contextBusy}
            title={changeProjectTitle}
            aria-label={`Project: ${dirLabel}`}
          >
            <ProjectIcon data-icon="inline-start" />
            <span className="truncate">{dirLabel}</span>
            <ChevronsUpDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56 max-w-96">
          <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {recentProjects.length === 0 ? (
            <DropdownMenuItem disabled data-testid="recent-projects-empty">
              No recent projects
            </DropdownMenuItem>
          ) : (
            recentProjects.map((dir) => {
              const active = dir === status.projectDir;
              return (
                <DropdownMenuItem
                  key={dir}
                  disabled={active || contextBusy || !onOpenRecentProject}
                  title={dir}
                  onSelect={() => onOpenRecentProject?.(dir)}
                >
                  <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>
                    {formatProjectDirLabel(dir, recentProjects)}
                  </span>
                  {active && (
                    <Badge variant="outline" className="shrink-0 text-[0.6rem]">
                      active
                    </Badge>
                  )}
                </DropdownMenuItem>
              );
            })
          )}
          <DropdownMenuSeparator />
          {onConnectGitHub ? (
            <DropdownMenuItem
              disabled={contextBusy}
              onSelect={() => onConnectGitHub()}
              data-testid="recent-projects-connect"
            >
              <GitPullRequest data-icon="inline-start" />
              Connect GitHub repository…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={contextBusy}
            onSelect={() => onChangeProject()}
            data-testid="recent-projects-open"
          >
            <FolderOpen data-icon="inline-start" />
            Open existing folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {gitReady && branchName ? (
        <Badge
          variant="outline"
          title={`Current branch: ${branchName}`}
          aria-label={`Current branch: ${branchName}`}
          className={cn(contextChipClassName, "max-w-56 truncate")}
          data-testid="git-branch"
        >
          <GitBranch data-icon="inline-start" />
          <span className="truncate">{branchName}</span>
        </Badge>
      ) : null}

      {gitReady && syncLabel ? (
        <Badge
          variant={
            gitSync?.kind === "skipped_dirty" || gitSync?.kind === "diverged"
              ? "destructive"
              : "outline"
          }
          title={gitSync?.message}
          aria-label={`Project updates: ${syncLabel}`}
          className={cn(contextChipSizeClassName, "max-w-48 truncate")}
          data-testid="git-sync-status"
        >
          {syncLabel}
        </Badge>
      ) : null}

      {gitReady && showUpdate ? (
        <Button
          variant={gitSync?.kind === "behind" ? "default" : "outline"}
          size="sm"
          onClick={onUpdateFromRemote}
          disabled={!updateEnabled}
          title={updateTitle}
          aria-label="Get latest changes"
          data-testid="update-from-remote"
        >
          <CloudDownload
            data-icon="inline-start"
            className={updatingFromRemote ? "animate-pulse" : ""}
          />
          Get updates
        </Button>
      ) : null}

      <span className="ml-auto flex min-w-0 shrink items-center gap-2">
        {gitReady && trackerLabel ? (
          canSwitchTracker ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={contextBusy}
                  aria-label={`Task tracker: ${trackerLabel}`}
                  title={trackerTitle}
                  className={contextChipClassName}
                >
                  <ContextRoleLabel>Tracker</ContextRoleLabel>
                  <span className="truncate">{trackerLabel}</span>
                  <ChevronsUpDown data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel>Task tracker</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {trackers.map((tracker) => {
                  const active = tracker.id === status.activeTrackerId;
                  return (
                    <DropdownMenuItem
                      key={tracker.id}
                      disabled={active || contextBusy}
                      onSelect={() => onSwitchTracker(tracker.id)}
                    >
                      <span className={cn("flex-1", active && "font-medium")}>
                        {tracker.displayName}
                      </span>
                      {active && (
                        <Badge variant="outline" className="text-[0.6rem]">
                          active
                        </Badge>
                      )}
                    </DropdownMenuItem>
                  );
                })}
                {canChangeTrackerSettings ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={contextBusy}
                      onSelect={() => onChangeTrackerSettings?.()}
                      data-testid="tracker-change-settings"
                    >
                      <Settings2 data-icon="inline-start" />
                      Add or change tracker…
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Badge
              variant="outline"
              title="Active task tracker"
              aria-label={`Task tracker: ${trackerLabel}`}
              className={contextChipClassName}
            >
              <ContextRoleLabel>Tracker</ContextRoleLabel>
              <span className="truncate">{trackerLabel}</span>
            </Badge>
          )
        ) : null}

        {gitReady && status.configured && status.supportsProjectSwitch ? (
          canSwitchProject ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={contextBusy}
                  aria-label={`Project: ${projectValue}`}
                  title={projectTitle}
                  className={cn(contextChipClassName, "max-w-56")}
                >
                  <ContextRoleLabel>Project</ContextRoleLabel>
                  <span className="truncate">{projectValue}</span>
                  <ChevronsUpDown data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56 max-w-80">
                <DropdownMenuLabel>Project</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {projects.map((project) => {
                  const active = project.key === status.defaultProjectKey;
                  return (
                    <DropdownMenuItem
                      key={project.key}
                      disabled={active || contextBusy}
                      onSelect={() => onSwitchProjectKey(project.key)}
                    >
                      <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>
                        {project.name}
                        {project.name !== project.key ? (
                          <span className="text-muted-foreground"> ({project.key})</span>
                        ) : null}
                      </span>
                      {active && (
                        <Badge variant="outline" className="shrink-0 text-[0.6rem]">
                          active
                        </Badge>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : status.projectsError ? (
            <Badge
              variant="destructive"
              title={status.projectsError}
              aria-label="Project: Projects unavailable"
              className={contextChipSizeClassName}
            >
              <ContextRoleLabel>Project</ContextRoleLabel>
              <span className="truncate">Projects unavailable</span>
            </Badge>
          ) : projectLabel ? (
            <Badge
              variant="outline"
              title="Active project"
              aria-label={`Project: ${projectLabel}`}
              className={contextChipClassName}
            >
              <ContextRoleLabel>Project</ContextRoleLabel>
              <span className="max-w-40 truncate">{projectLabel}</span>
            </Badge>
          ) : projects.length === 0 ? (
            <Badge
              variant="outline"
              title="No remote projects returned"
              aria-label="Project: No projects"
              className={contextChipClassName}
            >
              <ContextRoleLabel>Project</ContextRoleLabel>
              <span className="truncate">No projects</span>
            </Badge>
          ) : null
        ) : null}

        {gitReady && harnessLabel ? (
          canSwitchHarness ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={contextBusy}
                  aria-label={`Harness: ${harnessLabel}`}
                  title={harnessTitle}
                  className={cn(contextChipClassName, "max-w-56")}
                >
                  <ContextRoleLabel>Harness</ContextRoleLabel>
                  <span className="truncate">{harnessLabel}</span>
                  <ChevronsUpDown data-icon="inline-end" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel>Agent harness</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {harnesses.map((harness) => {
                  const active = harness.name === status.activeHarnessName;
                  return (
                    <DropdownMenuItem
                      key={harness.name}
                      disabled={active || contextBusy}
                      onSelect={() => onSwitchHarness(harness.name)}
                    >
                      <span className={cn("flex-1", active && "font-medium")}>
                        {harness.displayName}
                      </span>
                      {active && (
                        <Badge variant="outline" className="text-[0.6rem]">
                          active
                        </Badge>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Badge
              variant="outline"
              title="Agent harness"
              aria-label={`Harness: ${harnessLabel}`}
              className={contextChipClassName}
            >
              <ContextRoleLabel>Harness</ContextRoleLabel>
              <span className="max-w-40 truncate">{harnessLabel}</span>
            </Badge>
          )
        ) : null}
        <AnalyticsSettings
          projectDir={status.projectDir}
          projectBinding={status.projectBinding}
          onProjectRemoved={onProjectRemoved}
          agentRunning={agentRunning}
          updatingFromRemote={updatingFromRemote}
        />
      </span>
    </header>
  );
}
