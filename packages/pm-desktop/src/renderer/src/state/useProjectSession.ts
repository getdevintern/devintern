/**
 * Project session wiring extracted from `App.tsx`: status application, project
 * loads, tracker/harness/model/effort switches, and the setup/connect dialogs.
 */

import { useCallback, useEffect, useState } from "react";
import { issueTypeIfNeedsReset, resolveIssueTypes } from "../lib/issue-types.ts";
import { pruneSelectedLabels } from "../lib/labels.ts";
import { queryClient } from "../lib/query-client.ts";
import { invalidateProjectQueries } from "../queries/invalidate.ts";
import { qk } from "../queries/keys.ts";
import { seedProjectStatusCaches } from "../queries/seed.ts";
import { defaultComposerForProject } from "./composer-values.ts";
import { toError } from "./ipc-error.ts";
import { useProjectStore } from "./project-store.ts";
import { isContextBusy } from "./selectors.ts";
import { useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

export interface UseProjectSessionOptions {
  toolsBlocked: boolean;
  toolsOk: boolean;
  toolsProbeFailed: boolean;
}

export function useProjectSession(options: UseProjectSessionOptions) {
  const { toolsBlocked, toolsOk, toolsProbeFailed } = options;

  /** In-app setup wizard for unconfigured / misconfigured projects. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** Post-init tracker settings wizard (add / reconfigure a tracker). */
  const [trackerSettingsOpen, setTrackerSettingsOpen] = useState(false);
  /** Connect a GitHub repository → managed clone dialog. */
  const [connectOpen, setConnectOpen] = useState(false);
  const [codeDiscoveryDismissError, setCodeDiscoveryDismissError] = useState<string | null>(null);

  const applyProjectStatus = useCallback(
    (next: ProjectStatus, options?: { keepWorkspaces?: boolean }) => {
      const projectStore = useProjectStore.getState();
      const workspacesStore = useTicketWorkspacesStore.getState();
      projectStore.setChromeError(null);
      const prevDefaultProjectKey = projectStore.status?.defaultProjectKey;
      projectStore.setStatus(next);
      // Seed the issue-type + label query caches for the default project key
      // from the embedded status payload (avoids an extra IPC round-trip).
      seedProjectStatusCaches(queryClient, next);
      const types = resolveIssueTypes(next.issueTypes);
      const nextLabels = next.labels ?? [];
      // Update / similar chrome refreshes keep open tickets; full project loads reset.
      if (options?.keepWorkspaces) {
        // Unconfigured after Update → clear workspaces (same as a failed load).
        if (!next.configured) {
          workspacesStore.projectReset();
          return;
        }
        if (next.defaultProjectKey && next.defaultProjectKey !== prevDefaultProjectKey) {
          workspacesStore.defaultProjectChanged(next.defaultProjectKey);
        }
        // Issue-type / label lists may have changed while tickets stayed open.
        const keepUnknown = Boolean(next.supportsFreeformLabels);
        for (const ticket of workspacesStore.tickets) {
          const reset = issueTypeIfNeedsReset(ticket.composer.issueType, types);
          const prunedLabels =
            ticket.composer.labels.length === 0
              ? null
              : pruneSelectedLabels(ticket.composer.labels, nextLabels, { keepUnknown });
          const labelsChanged =
            prunedLabels !== null &&
            (prunedLabels.length !== ticket.composer.labels.length ||
              prunedLabels.some((id, i) => id !== ticket.composer.labels[i]));
          if (reset === null && !labelsChanged) continue;
          workspacesStore.patchComposer(ticket.id, {
            ...(reset !== null ? { issueType: reset } : {}),
            ...(labelsChanged && prunedLabels ? { labels: prunedLabels } : {}),
          });
        }
        return;
      }
      // Only auto-open a ticket workspace when the project is fully ready.
      // Unconfigured git folders keep an empty sidebar; non-git folders clear tickets.
      if (next.isGitRepository && next.configured) {
        workspacesStore.projectLoaded(defaultComposerForProject(next, types));
      } else {
        workspacesStore.projectReset();
      }
    },
    [],
  );

  const loadProject = useCallback(
    async (dir: string) => {
      useProjectStore.getState().setLoadingProject(true);
      try {
        const result = await window.pm.getProjectStatus(dir);
        if (!result.ok) return;
        // Close setup only after a successful status load so a failed IPC call
        // does not leave a confusing intermediate UI with stale project status.
        setSetupOpen(false);
        const next = result.value;
        // Recents update in main on successful open; invalidate before applying
        // status so ProjectBar never paints with a missing active recent.
        await invalidateProjectQueries(queryClient);
        applyProjectStatus(next);
        // Auto-open setup for git folders that still need `.devintern-pm` (choose
        // folder and restore-last-project both land here).
        if (next.isGitRepository && !next.configured) {
          setSetupOpen(true);
        }
      } finally {
        useProjectStore.getState().setLoadingProject(false);
      }
    },
    [applyProjectStatus],
  );

  const switchTracker = useCallback(
    async (trackerId: string) => {
      const projectStore = useProjectStore.getState();
      const current = projectStore.status;
      if (!current || current.activeTrackerId === trackerId) return;
      // Ignore while session switch, Update, or any agent run is already in progress.
      if (isContextBusy()) return;
      projectStore.setLoadingProject(true);
      projectStore.setChromeError(null);
      try {
        const result = await window.pm.switchTracker(trackerId);
        if (!result.ok) {
          projectStore.setChromeError(toError(result.error).message);
          return;
        }
        // Bust stale tracker caches (issue types + labels) for all keys
        // before seeding the new default key from the status payload.
        await invalidateProjectQueries(queryClient);
        applyProjectStatus(result.value);
      } finally {
        useProjectStore.getState().setLoadingProject(false);
      }
    },
    [applyProjectStatus],
  );

  const switchProjectKey = useCallback(async (projectKey: string) => {
    const projectStore = useProjectStore.getState();
    const current = projectStore.status;
    if (!current || current.defaultProjectKey === projectKey) return;
    // Ignore while session switch, Update, or any agent run is already in progress.
    if (isContextBusy()) return;
    projectStore.setLoadingProject(true);
    projectStore.setChromeError(null);
    try {
      const result = await window.pm.switchProjectKey(projectKey);
      if (!result.ok) {
        projectStore.setChromeError(toError(result.error).message);
        return;
      }
      const next = result.value;
      projectStore.setChromeError(null);
      projectStore.setStatus(next);
      // Seed issue-type + label caches for the new default key from the
      // embedded status payload; bust stale tracker caches for other keys.
      seedProjectStatusCaches(queryClient, next);
      await invalidateProjectQueries(queryClient);
      const nextLabels = next.labels ?? [];
      const workspacesStore = useTicketWorkspacesStore.getState();
      workspacesStore.defaultProjectChanged(projectKey);
      // Clear selections that belong to the previous project's label set.
      // Re-read tickets AFTER the dispatch so tickets opened/closed during the
      // await are included (matches the original ticketsRef.current intent).
      // default-project-changed only updates projectKey, so reading labels
      // from the post-dispatch snapshot is equivalent to the pre-dispatch one.
      const keepUnknown = Boolean(next.supportsFreeformLabels);
      const tickets = useTicketWorkspacesStore.getState().tickets;
      for (const ticket of tickets) {
        if (ticket.composer.labels.length === 0) continue;
        workspacesStore.patchComposer(ticket.id, {
          labels: pruneSelectedLabels(ticket.composer.labels, nextLabels, { keepUnknown }),
        });
      }
    } finally {
      useProjectStore.getState().setLoadingProject(false);
    }
  }, []);

  const switchHarness = useCallback(async (harnessName: string) => {
    const projectStore = useProjectStore.getState();
    const current = projectStore.status;
    if (!current || current.activeHarnessName === harnessName) return;
    // Ignore while session switch, Update, or any agent run is already in progress.
    if (isContextBusy()) return;
    projectStore.setLoadingProject(true);
    projectStore.setChromeError(null);
    try {
      const result = await window.pm.switchHarness(harnessName);
      if (!result.ok) {
        projectStore.setChromeError(toError(result.error).message);
        return;
      }
      // Harness switches keep open tickets; only the agent for subsequent
      // generate/edit/decompose changes. Tracker / directory loads still use
      // applyProjectStatus.
      projectStore.setChromeError(null);
      projectStore.setStatus(result.value);
    } finally {
      useProjectStore.getState().setLoadingProject(false);
    }
  }, []);

  // Persist AGENT_MODEL and apply the reloaded session status. Resolves with
  // an error message on failure (surfaced inline in Settings), null on success.
  const switchModel = useCallback(async (model: string): Promise<string | null> => {
    const projectStore = useProjectStore.getState();
    if (isContextBusy()) return "Another operation is in progress. Try again in a moment.";
    projectStore.setLoadingProject(true);
    try {
      const result = await window.pm.switchModel(model);
      if (!result.ok) return toError(result.error).message;
      // Model switches keep open tickets; only the agent for subsequent
      // generate/edit/decompose changes.
      projectStore.setStatus(result.value);
      return null;
    } finally {
      useProjectStore.getState().setLoadingProject(false);
    }
  }, []);

  // Persist AGENT_EFFORT and apply the reloaded session status. Same contract
  // as switchModel: error message on failure, null on success.
  const switchEffort = useCallback(async (effort: string): Promise<string | null> => {
    const projectStore = useProjectStore.getState();
    if (isContextBusy()) return "Another operation is in progress. Try again in a moment.";
    projectStore.setLoadingProject(true);
    try {
      const result = await window.pm.switchEffort(effort);
      if (!result.ok) return toError(result.error).message;
      // Effort switches keep open tickets; only the agent for subsequent
      // generate/edit/decompose changes.
      projectStore.setStatus(result.value);
      return null;
    } finally {
      useProjectStore.getState().setLoadingProject(false);
    }
  }, []);

  // Restore last project only after required tools are present, so a missing
  // git/agent CLI surfaces on launch instead of as a later spawn error.
  useEffect(() => {
    if (toolsBlocked || toolsProbeFailed) {
      useProjectStore.getState().setLoadingProject(false);
      return;
    }
    if (!toolsOk) return;
    let cancelled = false;
    useProjectStore.getState().setLoadingProject(true);
    void (async () => {
      try {
        const last = await window.pm.getLastProjectDir();
        if (cancelled) return;
        if (last.ok && last.value) {
          await loadProject(last.value);
        } else {
          useProjectStore.getState().setLoadingProject(false);
        }
      } catch {
        if (!cancelled) useProjectStore.getState().setLoadingProject(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProject, toolsBlocked, toolsOk, toolsProbeFailed]);

  const chooseProject = async () => {
    // Ignore while session switch, Update, or any agent run is already in progress.
    if (isContextBusy()) return;
    const result = await window.pm.chooseProjectDir();
    if (result.ok && result.value) {
      await loadProject(result.value);
    }
  };

  const openConnectGitHub = useCallback(() => {
    if (isContextBusy()) return;
    // Defer past DropdownMenu dismissable-layer cleanup. Opening Dialog in the
    // same tick inherits body { pointer-events: none } and leaves the UI frozen
    // after close (Radix #3317 / #837).
    window.setTimeout(() => setConnectOpen(true), 0);
  }, []);

  const openTrackerSettings = useCallback(() => {
    if (isContextBusy()) return;
    // Defer past DropdownMenu dismissable-layer cleanup (same reason as
    // openConnectGitHub — the tracker chip is a DropdownMenu trigger).
    window.setTimeout(() => setTrackerSettingsOpen(true), 0);
  }, []);

  const onGitHubConnected = useCallback(
    async (next: ProjectStatus) => {
      useProjectStore.getState().setLoadingProject(true);
      try {
        setSetupOpen(false);
        await invalidateProjectQueries(queryClient);
        applyProjectStatus(next);
        if (next.isGitRepository && !next.configured) {
          setSetupOpen(true);
        }
      } finally {
        useProjectStore.getState().setLoadingProject(false);
      }
    },
    [applyProjectStatus],
  );

  const onProjectRemoved = useCallback(() => {
    useProjectStore.getState().clearProject();
    useTicketWorkspacesStore.getState().projectReset();
    setSetupOpen(false);
    void invalidateProjectQueries(queryClient);
  }, []);

  const openRecentProject = useCallback(
    async (dir: string) => {
      if (isContextBusy()) return;
      if (useProjectStore.getState().status?.projectDir === dir) return;
      await loadProject(dir);
    },
    [loadProject],
  );

  const onRecentMenuOpenChange = useCallback((open: boolean) => {
    if (open) void queryClient.invalidateQueries({ queryKey: qk.recentProjects });
  }, []);

  const onSetupComplete = useCallback(
    (next: ProjectStatus) => {
      // Invalidate recents + tracker caches, then apply so status commits in one paint.
      void (async () => {
        await invalidateProjectQueries(queryClient);
        applyProjectStatus(next);
        setSetupOpen(false);
      })();
    },
    [applyProjectStatus],
  );

  const onTrackerSettingsComplete = useCallback(
    (next: ProjectStatus) => {
      void (async () => {
        await invalidateProjectQueries(queryClient);
        applyProjectStatus(next);
        setTrackerSettingsOpen(false);
      })();
    },
    [applyProjectStatus],
  );

  const updateFromRemote = useCallback(async () => {
    const projectStore = useProjectStore.getState();
    if (!projectStore.status?.isGitRepository) return;
    if (isContextBusy()) return;
    projectStore.setUpdatingFromRemote(true);
    projectStore.setChromeError(null);
    try {
      const result = await window.pm.updateProjectFromRemote();
      if (!result.ok) {
        projectStore.setChromeError(toError(result.error).message);
        return;
      }
      // Keep open tickets; refresh chrome + issue types (main reloaded the session).
      // Bust stale tracker caches before seeding the new default key.
      await invalidateProjectQueries(queryClient);
      applyProjectStatus(result.value, { keepWorkspaces: true });
    } finally {
      useProjectStore.getState().setUpdatingFromRemote(false);
    }
  }, [applyProjectStatus]);

  const dismissCodeDiscovery = useCallback(async () => {
    setCodeDiscoveryDismissError(null);
    const result = await window.pm.dismissCodeDiscovery();
    if (result.ok) {
      // Keep the shared query cache in sync so other readers see the dismissal.
      queryClient.setQueryData(qk.codeDiscoveryDismissed, true);
      return;
    }
    setCodeDiscoveryDismissError(toError(result.error).message);
  }, []);

  return {
    setupOpen,
    setSetupOpen,
    trackerSettingsOpen,
    setTrackerSettingsOpen,
    connectOpen,
    setConnectOpen,
    codeDiscoveryDismissError,
    dismissCodeDiscovery,
    loadProject,
    switchTracker,
    switchProjectKey,
    switchHarness,
    switchModel,
    switchEffort,
    chooseProject,
    openConnectGitHub,
    openTrackerSettings,
    onGitHubConnected,
    onProjectRemoved,
    openRecentProject,
    onRecentMenuOpenChange,
    onSetupComplete,
    onTrackerSettingsComplete,
    updateFromRemote,
  };
}
