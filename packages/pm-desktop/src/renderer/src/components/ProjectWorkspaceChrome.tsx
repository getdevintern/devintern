/**
 * Suitability-gated chrome around the ticket workspace.
 *
 * Encodes the mutual exclusion between invalid-project surfaces, setup banner /
 * wizard, and ticket chrome so App and tests share one decision path.
 */

import type { ReactNode } from "react";
import { ProjectSetupWizard } from "./ProjectSetupWizard.tsx";
import {
  InvalidProjectBanner,
  InvalidProjectEmptyState,
  SetupBanner,
  SetupEmptyState,
} from "./SetupEmptyState.tsx";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

export interface ProjectWorkspaceChromeProps {
  status: ProjectStatus;
  setupOpen: boolean;
  onSetupOpenChange: (open: boolean) => void;
  onSetupComplete: (next: ProjectStatus) => void;
  onChangeProject: () => void;
  /** Ticket sidebar + main area — only rendered for git + configured projects. */
  children: ReactNode;
}

export function ProjectWorkspaceChrome({
  status,
  setupOpen,
  onSetupOpenChange,
  onSetupComplete,
  onChangeProject,
  children,
}: ProjectWorkspaceChromeProps) {
  const canRecoverViaTrackerSwitch = (status.configuredTrackers ?? []).some(
    (t) => t.id !== status.activeTrackerId,
  );
  const openSetup = () => onSetupOpenChange(true);

  return (
    <>
      {!status.isGitRepository ? (
        <InvalidProjectBanner onChangeProject={onChangeProject} />
      ) : !status.configured ? (
        <SetupBanner onSetup={openSetup} canRecoverViaTrackerSwitch={canRecoverViaTrackerSwitch} />
      ) : null}
      {status.isGitRepository && (
        <ProjectSetupWizard
          projectDir={status.projectDir}
          open={setupOpen}
          onOpenChange={onSetupOpenChange}
          onComplete={onSetupComplete}
        />
      )}
      {!status.isGitRepository ? (
        <InvalidProjectEmptyState onChangeProject={onChangeProject} />
      ) : !status.configured ? (
        <SetupEmptyState onSetup={openSetup} />
      ) : (
        children
      )}
    </>
  );
}
