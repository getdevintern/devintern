import { ChevronsUpDown, FolderOpen } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

interface ProjectBarProps {
  status: ProjectStatus;
  onChangeProject: () => void;
  onSwitchTracker: (trackerId: string) => void;
  onSwitchProjectKey: (projectKey: string) => void;
  switching?: boolean;
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

function directoryLabel(projectDir: string): string {
  const parts = projectDir.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? projectDir;
}

export function ProjectBar({
  status,
  onChangeProject,
  onSwitchTracker,
  onSwitchProjectKey,
  switching = false,
}: ProjectBarProps) {
  const trackers = status.configuredTrackers ?? [];
  const trackerLabel =
    status.activeTrackerDisplayName ?? status.backendName ?? status.activeTrackerId;
  // Offer a menu when multiple trackers are ready, or when the active one
  // failed to load but another configured tracker can take over.
  const activeTrackerConfigured = trackers.some((t) => t.id === status.activeTrackerId);
  const canSwitchTracker =
    !switching && trackers.length > 0 && (trackers.length > 1 || !activeTrackerConfigured);
  const projectLabel = activeProjectLabel(status);
  const dirLabel = directoryLabel(status.projectDir);
  const projects = status.projects ?? [];
  const canSwitchProject =
    Boolean(status.supportsProjectSwitch) &&
    status.configured &&
    projects.length > 1 &&
    !switching &&
    !status.projectsError;

  return (
    <header className="flex min-w-0 items-center gap-2 border-b bg-card px-3 py-2">
      <span className="shrink-0 text-sm font-semibold">
        <span className="product-pm">devintern</span>
        <span className="product-sep">/</span>
        <span>pm</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="min-w-0 max-w-full"
        onClick={onChangeProject}
        title={status.projectDir}
      >
        <FolderOpen data-icon="inline-start" />
        <span className="truncate">{dirLabel}</span>
      </Button>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {trackerLabel ? (
          canSwitchTracker ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={switching}
                  aria-label="Switch task tracker"
                  title="Switch task tracker"
                >
                  {trackerLabel}
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
                      disabled={active || switching}
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
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Badge variant="secondary" title="Active task tracker">
              {trackerLabel}
            </Badge>
          )
        ) : null}

        {status.configured && status.supportsProjectSwitch ? (
          canSwitchProject ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={switching}
                  aria-label="Switch project"
                  title="Switch project"
                  className="max-w-56"
                >
                  <span className="truncate">{projectLabel ?? "Select project"}</span>
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
                      disabled={active || switching}
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
            <Badge variant="destructive" title={status.projectsError}>
              Projects unavailable
            </Badge>
          ) : projectLabel ? (
            <Badge variant="outline" title="Active project">
              <span className="max-w-40 truncate">{projectLabel}</span>
            </Badge>
          ) : projects.length === 0 ? (
            <Badge variant="outline" title="No remote projects returned">
              No projects
            </Badge>
          ) : null
        ) : null}

        {status.harnessDisplayName && <Badge variant="outline">{status.harnessDisplayName}</Badge>}
        <AnalyticsSettings />
      </span>
    </header>
  );
}
