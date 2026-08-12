/**
 * Project chrome store for the desktop PM app.
 *
 * Owns the project-level session state that used to live as `useState` in
 * `App.tsx`: the loaded `ProjectStatus`, the `loadingProject` /
 * `updatingFromRemote` flags, and the transient `chromeError` string. Moving
 * this into a Zustand store eliminates the `statusRef` stale-closure mirror
 * (callbacks can read `useProjectStore.getState()` directly) and lets
 * `ProjectBar` / `ComposerForm` / `ProjectWorkspaceChrome` read the status
 * without prop drilling.
 *
 * Cross-cutting derived state (e.g. `contextBusy`, which also depends on
 * ticket workspaces) lives in `./selectors.ts` so this store stays leaf-level
 * and free of imports from the ticket store.
 */

import { createBoundStore } from "./create-store.ts";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

export interface ProjectStoreState {
  /** Loaded project session status, or null before/after a project is open. */
  status: ProjectStatus | null;
  /** True from mount through restore-last-project (or until we know there is none). */
  loadingProject: boolean;
  /** True while update-from-remote IPC is in flight. */
  updatingFromRemote: boolean;
  /** Transient error from tracker/project/harness switch or git update IPC. */
  chromeError: string | null;
}

export interface ProjectStoreActions {
  setStatus: (next: ProjectStatus | null) => void;
  setLoadingProject: (value: boolean) => void;
  setUpdatingFromRemote: (value: boolean) => void;
  setChromeError: (value: string | null) => void;
  /** Clear the loaded project (after removing a managed clone). Resets flags + error. */
  clearProject: () => void;
}

export type ProjectStore = ProjectStoreState & ProjectStoreActions;

const initialState: ProjectStoreState = {
  status: null,
  loadingProject: true,
  updatingFromRemote: false,
  chromeError: null,
};

export const useProjectStore = createBoundStore<ProjectStore>((set) => ({
  ...initialState,
  setStatus: (next) => set({ status: next }),
  setLoadingProject: (loadingProject) => set({ loadingProject }),
  setUpdatingFromRemote: (updatingFromRemote) => set({ updatingFromRemote }),
  setChromeError: (chromeError) => set({ chromeError }),
  clearProject: () =>
    set({
      status: null,
      loadingProject: false,
      updatingFromRemote: false,
      chromeError: null,
    }),
}));

/** Reset the store to a pristine state (tests only). */
export function resetProjectStore(): void {
  useProjectStore.setState({ ...initialState });
}
