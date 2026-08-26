export interface WorkerWorkspaceModeOptions {
  workspaceRequested: boolean;
  noWorkspace: boolean;
  listen: boolean;
  workspaceExists: boolean;
}

export interface WorkerWorkspaceMode {
  workspace: boolean;
  conflict?: "workspace-listen";
}

/** Resolve legacy single-repo versus workspace mode before worker startup. */
export function resolveWorkerWorkspaceMode(
  options: WorkerWorkspaceModeOptions,
): WorkerWorkspaceMode {
  if (options.workspaceRequested && options.listen) {
    return { workspace: false, conflict: "workspace-listen" };
  }

  return {
    workspace:
      options.workspaceRequested ||
      (!options.noWorkspace && !options.listen && options.workspaceExists),
  };
}
