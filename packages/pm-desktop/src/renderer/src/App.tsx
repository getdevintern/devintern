import { useCallback, useEffect, useState } from "react";
import { ABOUT_VERSION_UNAVAILABLE, AboutDialog } from "./components/AboutDialog.tsx";
import { ComposerForm, initialComposerValues } from "./components/ComposerForm.tsx";
import type { ComposerValues } from "./components/ComposerForm.tsx";
import { NoTicketsEmptyState } from "./components/NoTicketsEmptyState.tsx";
import { OutputPanel } from "./components/OutputPanel.tsx";
import { ConnectGitHubDialog } from "./components/ConnectGitHubDialog.tsx";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { ProjectSetupWizard } from "./components/ProjectSetupWizard.tsx";
import { ProjectWorkspaceChrome } from "./components/ProjectWorkspaceChrome.tsx";
import { RequiredToolsGate } from "./components/RequiredToolsGate.tsx";
import { Welcome } from "./components/SetupEmptyState.tsx";
import { TicketSidebar } from "./components/TicketSidebar.tsx";
import { UpdateNotifier } from "./components/UpdateNotifier.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DEFAULT_ISSUE_TYPES,
  getDefaultIssueType,
  issueTypeIfNeedsReset,
  resolveIssueTypes,
} from "./lib/issue-types.ts";
import { pruneSelectedLabels, selectionAfterLabelsFailure } from "./lib/labels.ts";
import { queryClient } from "./lib/query-client.ts";
import { invalidateLabels, invalidateProjectQueries } from "./queries/invalidate.ts";
import { qk } from "./queries/keys.ts";
import { seedProjectStatusCaches } from "./queries/seed.ts";
import { useAppVersion } from "./queries/useAppVersion.ts";
import { useCodeDiscoveryDismissed } from "./queries/useCodeDiscoveryDismissed.ts";
import { useIssueTypes } from "./queries/useIssueTypes.ts";
import { useLabels } from "./queries/useLabels.ts";
import { useRecentProjects } from "./queries/useRecentProjects.ts";
import { useToolValidation } from "./queries/useToolValidation.ts";
import { isBusy } from "./state/app-store.ts";
import { composerForCapture } from "./state/composer-values.ts";
import { useProjectStore } from "./state/project-store.ts";
import {
  useActiveTicket,
  useAnyTicketBusy,
  isContextBusy,
  isTicketActionBlocked,
} from "./state/selectors.ts";
import {
  getActiveTicketFromStore,
  useTicketWorkspacesStore,
} from "./state/ticket-workspaces-store.ts";
import { nextTicketId } from "./state/ticket-workspaces.ts";
import type { IpcError, ProjectStatus, QuickCaptureEvent } from "../../shared/ipc-contract.ts";
import { shouldShowCodeDiscovery } from "../../shared/code-discovery.ts";
import { isToolValidationBlocking } from "../../shared/tool-validation.ts";

let requestCounter = 0;
const nextRequestId = () => `req-${++requestCounter}`;

function toError(error: IpcError | undefined): IpcError {
  return error ?? { code: "error", message: "Unknown error" };
}

function queryErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Unknown error";
}

function defaultComposerForProject(status: ProjectStatus, issueTypes: string[]): ComposerValues {
  const types = resolveIssueTypes(issueTypes);
  return {
    ...initialComposerValues,
    sourceContent: { ...initialComposerValues.sourceContent },
    projectKey: status.defaultProjectKey ?? "",
    issueType: getDefaultIssueType(types),
  };
}

export function App() {
  const status = useProjectStore((s) => s.status);
  const loadingProject = useProjectStore((s) => s.loadingProject);
  const updatingFromRemote = useProjectStore((s) => s.updatingFromRemote);
  const chromeError = useProjectStore((s) => s.chromeError);
  const [codeDiscoveryDismissError, setCodeDiscoveryDismissError] = useState<string | null>(null);

  const activeTicket = useActiveTicket();
  const anyTicketBusy = useAnyTicketBusy();

  // Leaf queries (data fetching only; client state lives in the stores).
  const appVersionQuery = useAppVersion();
  const appVersion =
    appVersionQuery.data ?? (appVersionQuery.isError ? ABOUT_VERSION_UNAVAILABLE : null);
  const codeDiscoveryQuery = useCodeDiscoveryDismissed();
  const codeDiscoveryDismissed = codeDiscoveryQuery.data ?? null;
  const recentProjectsQuery = useRecentProjects();
  const recentProjects = recentProjectsQuery.data ?? null;
  const toolsQuery = useToolValidation();
  const toolsOk = toolsQuery.data?.ok === true;
  const toolsBlocked = isToolValidationBlocking(toolsQuery.data);
  const toolsProbeFailed = toolsQuery.isError && !toolsOk;
  const toolsError = toolsProbeFailed ? queryErrorMessage(toolsQuery.error) : null;

  /** Pending close when the ticket still has an agent/operation in flight. */
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  const closeConfirmTicket = useTicketWorkspacesStore((s) =>
    closeConfirmId ? (s.tickets.find((t) => t.id === closeConfirmId) ?? null) : null,
  );
  /** In-app setup wizard for unconfigured / misconfigured projects. */
  const [setupOpen, setSetupOpen] = useState(false);
  /**
   * Bumped on every Quick Capture invocation so the composer focuses its
   * source editor (capture lands ready-to-type).
   */
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  /** Post-init tracker settings wizard (add / reconfigure a tracker). */
  const [trackerSettingsOpen, setTrackerSettingsOpen] = useState(false);
  /** Connect a GitHub repository → managed clone dialog. */
  const [connectOpen, setConnectOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  // Stream agent output into the ticket that owns the requestId (may be background).
  useEffect(() => {
    return window.pm.onAgentChunk((event) => {
      useTicketWorkspacesStore.getState().routeAgentChunk(event.requestId, event.chunk);
    });
  }, []);

  useEffect(() => {
    return window.pm.onShowAbout(() => {
      setAboutOpen(true);
    });
  }, []);

  // Quick Capture: OS global shortcut → focus app + open a fresh ticket
  // workspace prefilled from the clipboard. Existing tickets and running
  // streams are untouched (a new tab is opened; nothing is closed).
  useEffect(() => {
    return window.pm.onQuickCapture((event: QuickCaptureEvent) => {
      const current = useProjectStore.getState().status;
      // No project ready yet: the window is already focused by main, and the
      // Welcome screen / setup wizard is the visible path (never fail silently
      // into a broken composer).
      if (!current?.isGitRepository || !current.configured) return;

      // Issue types for the new ticket's default project key; seeded on load,
      // falls back to defaults until fetched (corrected by the reset effect).
      const cachedTypes =
        queryClient.getQueryData<string[]>(
          qk.issueTypes(current.projectDir, current.defaultProjectKey ?? ""),
        ) ?? DEFAULT_ISSUE_TYPES;
      const composer = defaultComposerForProject(current, resolveIssueTypes(cachedTypes));
      // Useful clipboard text prefills the inferred source tab; empty keeps
      // the Prompt tab ready to type (focus moves there via the signal).
      useTicketWorkspacesStore
        .getState()
        .openTicket(nextTicketId(), composerForCapture(composer, event));
      setComposerFocusToken((token) => token + 1);
    });
  }, []);

  // Consolidated auto-update subscription: push live status into the shared
  // query cache so AboutDialog / UpdateNotifier both read one entry without
  // each subscribing separately.
  useEffect(() => {
    return window.pm.onUpdateStatus((next) => {
      queryClient.setQueryData(qk.updateStatus, next);
    });
  }, []);

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

  // Active-ticket derivations used by the metadata hooks + composer pruning.
  const activeTicketId = activeTicket?.id;
  const activeProjectKey = activeTicket?.composer.projectKey;
  const activeIssueType = activeTicket?.composer.issueType;
  const projectDir = status?.projectDir ?? null;

  // Tracker-scoped queries (issue types + labels). Keys are scoped by dir +
  // projectKey so switching project dirs uses distinct cache entries. The
  // default-key cache is seeded from ProjectStatus by seedProjectStatusCaches.
  const metadataEnabled = !loadingProject && !updatingFromRemote && !!activeTicketId;
  const issueTypesQuery = useIssueTypes(
    projectDir,
    activeProjectKey ?? null,
    Boolean(status?.supportsIssueTypes) && metadataEnabled,
  );
  const labelsQuery = useLabels(
    projectDir,
    activeProjectKey ?? null,
    Boolean(status?.supportsLabels) && metadataEnabled,
  );
  // Stable fallback reference — spreading would allocate a new array every render.
  const issueTypes = issueTypesQuery.data ?? DEFAULT_ISSUE_TYPES;
  const labels = labelsQuery.data?.labels ?? [];
  const labelsTruncated = labelsQuery.data?.truncated ?? false;
  const labelsError = labelsQuery.error ? labelsQuery.error.message : null;

  // Reset the active ticket's issue type when the available list changes and
  // the current selection is no longer valid.
  useEffect(() => {
    if (!activeTicketId || !issueTypesQuery.data) return;
    const reset = issueTypeIfNeedsReset(activeIssueType, issueTypesQuery.data);
    if (reset !== null) {
      useTicketWorkspacesStore.getState().patchComposer(activeTicketId, { issueType: reset });
    }
  }, [activeTicketId, activeIssueType, issueTypesQuery.data]);

  // Prune the active ticket's selected labels when the label catalog changes
  // (new project key, refetch, capability toggle) or when labels fail to load.
  // Reads the current selection from the store (getState) so the effect does
  // not re-run on every chip toggle (which would loop through prune → patch).
  useEffect(() => {
    if (!activeTicketId) return;
    const workspacesStore = useTicketWorkspacesStore.getState();
    const ticket = workspacesStore.tickets.find((t) => t.id === activeTicketId);
    const selected = ticket?.composer.labels ?? [];
    if (!status?.supportsLabels) {
      if (selected.length > 0) {
        workspacesStore.patchComposer(activeTicketId, { labels: [] });
      }
      return;
    }
    const freeform = Boolean(status.supportsFreeformLabels);
    if (labelsQuery.error) {
      const cleared = selectionAfterLabelsFailure(selected, { keepOnFailure: freeform });
      if (cleared.length !== selected.length) {
        workspacesStore.patchComposer(activeTicketId, { labels: cleared });
      }
      return;
    }
    if (!labelsQuery.data) return;
    const pruned = pruneSelectedLabels(selected, labelsQuery.data.labels, {
      keepUnknown: freeform,
    });
    if (pruned.length !== selected.length || pruned.some((id, i) => id !== selected[i])) {
      workspacesStore.patchComposer(activeTicketId, { labels: pruned });
    }
  }, [
    activeTicketId,
    labelsQuery.data,
    labelsQuery.error,
    status?.supportsLabels,
    status?.supportsFreeformLabels,
  ]);

  const retryLabels = useCallback(() => {
    if (!projectDir || !activeProjectKey) return;
    invalidateLabels(queryClient, projectDir, activeProjectKey);
  }, [projectDir, activeProjectKey]);

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

  const canOpenTicket = Boolean(status?.isGitRepository && status.configured);

  const openTicket = useCallback(() => {
    // Only fully ready projects (git + configured PM) should open ticket workspaces.
    const current = useProjectStore.getState().status;
    if (!canOpenTicket || !current) return;
    const composer = defaultComposerForProject(current, issueTypes);
    useTicketWorkspacesStore.getState().openTicket(nextTicketId(), composer);
  }, [canOpenTicket, issueTypes]);

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

  const requestCloseTicket = useCallback((id: string) => {
    const ticket = useTicketWorkspacesStore.getState().tickets.find((t) => t.id === id);
    if (!ticket) return;
    if (isBusy(ticket.output.phase)) {
      setCloseConfirmId(id);
      return;
    }
    useTicketWorkspacesStore.getState().closeTicket(id);
  }, []);

  const confirmCloseTicket = () => {
    if (!closeConfirmId) return;
    useTicketWorkspacesStore.getState().closeTicket(closeConfirmId);
    setCloseConfirmId(null);
  };

  const generate = async () => {
    const ticket = getActiveTicketFromStore();
    if (!ticket) return;
    const ticketId = ticket.id;
    const values = ticket.composer;
    const content = values.sourceContent[values.sourceType];
    // Per-ticket + chrome only — another ticket generating must not block this one.
    if (!content.trim() || isTicketActionBlocked(ticket)) return;
    const requestId = nextRequestId();
    useTicketWorkspacesStore.getState().applyOutputAction(ticketId, {
      type: "generate-started",
      requestId,
    });
    const result = await window.pm.generateStory(requestId, {
      source: { type: values.sourceType, content },
      promptStyle: values.promptStyle,
      epicKey: values.epicKey || undefined,
      extraInstructions: values.extraInstructions || undefined,
      attachments: values.attachments.length > 0 ? values.attachments : undefined,
    });
    // Always target ticketId — user may have switched away while generating.
    const store = useTicketWorkspacesStore.getState();
    if (result.ok) {
      store.applyOutputAction(ticketId, { type: "generate-succeeded", draft: result.value });
    } else {
      store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
    }
  };

  const edit = async (editPrompt: string) => {
    const ticket = getActiveTicketFromStore();
    if (!ticket?.output.draft) return;
    // Same multi-ticket independence as Generate / Create Task.
    if (isTicketActionBlocked(ticket)) return;
    const ticketId = ticket.id;
    const draft = ticket.output.draft;
    const issueType = ticket.composer.issueType;
    const requestId = nextRequestId();
    const store = useTicketWorkspacesStore.getState();
    store.applyOutputAction(ticketId, { type: "edit-started", requestId });
    const result = await window.pm.editStory(requestId, {
      current: draft,
      editPrompt,
      issueType,
    });
    if (result.ok) {
      store.applyOutputAction(ticketId, { type: "edit-succeeded", draft: result.value });
    } else {
      store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
    }
  };

  const create = async () => {
    const ticket = getActiveTicketFromStore();
    if (!ticket?.output.draft) return;
    // Create Task on an idle ticket must not wait for an unrelated run.
    // isTicketActionBlocked also blocks double-clicks before create-started re-renders.
    if (isTicketActionBlocked(ticket)) return;
    const ticketId = ticket.id;
    const values = ticket.composer;
    const draft = ticket.output.draft;
    const currentStatus = useProjectStore.getState().status;
    // Hold a main-process agent request id across create + optional decompose so a
    // context switch cannot sneak into the gap between those IPCs (Set allows
    // concurrent holds from other tickets).
    const flowRequestId = `create-flow:${nextRequestId()}`;
    const store = useTicketWorkspacesStore.getState();
    store.applyOutputAction(ticketId, { type: "create-started" });
    const hold = await window.pm.beginAgentRequest(flowRequestId);
    if (!hold.ok) {
      store.applyOutputAction(ticketId, { type: "request-failed", error: toError(hold.error) });
      return;
    }
    try {
      const result = await window.pm.createTask({
        draft,
        issueType: values.issueType,
        projectKey: values.projectKey || undefined,
        epicKey: values.epicKey || undefined,
        // Omit labels while the picker failed — stale ids must not reach create.
        // Main ignores any prevalidation flag and re-checks against getLabels.
        labels:
          currentStatus?.supportsLabels &&
          values.labels.length > 0 &&
          (!labelsError || currentStatus.supportsFreeformLabels)
            ? values.labels
            : undefined,
        attachments: values.attachments.length > 0 ? values.attachments : undefined,
      });
      if (!result.ok) {
        store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
        return;
      }
      store.applyOutputAction(ticketId, { type: "create-succeeded", created: result.value });

      if (values.decompose) {
        const requestId = nextRequestId();
        store.applyOutputAction(ticketId, { type: "decompose-started", requestId });
        const decomposed = await window.pm.decomposeStory(requestId, {
          story: draft,
          sourceType: values.sourceType,
          promptStyle: values.promptStyle,
        });
        if (decomposed.ok) {
          store.applyOutputAction(ticketId, {
            type: "decompose-succeeded",
            subtasks: decomposed.value,
          });
        } else {
          store.applyOutputAction(ticketId, {
            type: "request-failed",
            error: toError(decomposed.error),
          });
        }
      }
    } finally {
      await window.pm.endAgentRequest(flowRequestId);
    }
  };

  const createSubtasks = async () => {
    const ticket = getActiveTicketFromStore();
    if (!ticket?.output.created) return;
    // Same multi-ticket independence as Generate / Create Task.
    if (isTicketActionBlocked(ticket)) return;
    const ticketId = ticket.id;
    const parentKey = ticket.output.created.key;
    const output = ticket.output;
    const projectKey = ticket.composer.projectKey || undefined;
    const selected = output.subtasks.filter((_, i) => output.selectedSubtasks.has(i));
    const store = useTicketWorkspacesStore.getState();
    store.applyOutputAction(ticketId, { type: "create-subtasks-started" });
    const result = await window.pm.createSubtasks(parentKey, selected, projectKey);
    if (result.ok) {
      store.applyOutputAction(ticketId, {
        type: "create-subtasks-finished",
        outcomes: result.value,
      });
    } else {
      store.applyOutputAction(ticketId, { type: "request-failed", error: toError(result.error) });
    }
  };

  const aboutDialog = (
    <AboutDialog
      open={aboutOpen}
      onOpenChange={setAboutOpen}
      version={appVersion}
      onOpenWebsite={(url) => void window.pm.openExternal(url)}
    />
  );

  if (!toolsOk && (toolsQuery.isPending || toolsBlocked || toolsProbeFailed)) {
    return (
      <>
        <RequiredToolsGate
          result={toolsQuery.data ?? null}
          checking={toolsQuery.isFetching}
          errorMessage={toolsError}
          onRecheck={() => {
            void toolsQuery.refetch();
          }}
          onOpenDocs={(url) => void window.pm.openExternal(url)}
        />
        {aboutDialog}
      </>
    );
  }

  if (!status) {
    return (
      <>
        <Welcome
          onConnectGitHub={openConnectGitHub}
          onChooseProject={chooseProject}
          loading={loadingProject}
          recentProjects={recentProjects}
          onOpenRecentProject={openRecentProject}
        />
        <ConnectGitHubDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
          onConnected={(next) => void onGitHubConnected(next)}
        />
        {aboutDialog}
      </>
    );
  }

  const showCodeDiscovery =
    codeDiscoveryDismissed !== null &&
    shouldShowCodeDiscovery({
      configured: status.configured,
      hasCodeConfig: status.hasCodeConfig === true,
      dismissed: codeDiscoveryDismissed,
    });

  return (
    <div className="flex h-screen flex-col">
      <ProjectBar
        onConnectGitHub={openConnectGitHub}
        onChangeProject={chooseProject}
        recentProjects={recentProjects ?? []}
        onOpenRecentProject={openRecentProject}
        onRecentMenuOpenChange={onRecentMenuOpenChange}
        onSwitchTracker={switchTracker}
        onSwitchProjectKey={switchProjectKey}
        onSwitchHarness={switchHarness}
        onSwitchModel={switchModel}
        onChangeTrackerSettings={openTrackerSettings}
        onUpdateFromRemote={updateFromRemote}
        onProjectRemoved={onProjectRemoved}
      />
      <ConnectGitHubDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(next) => void onGitHubConnected(next)}
      />
      {status.isGitRepository && status.configured ? (
        <ProjectSetupWizard
          projectDir={status.projectDir}
          open={trackerSettingsOpen}
          onOpenChange={setTrackerSettingsOpen}
          onComplete={onTrackerSettingsComplete}
          mode="update"
        />
      ) : null}
      <UpdateNotifier hasBusyWork={anyTicketBusy} />
      {chromeError && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{chromeError}</AlertDescription>
        </Alert>
      )}

      <ProjectWorkspaceChrome
        status={status}
        setupOpen={setupOpen}
        onSetupOpenChange={setSetupOpen}
        onSetupComplete={onSetupComplete}
        onChangeProject={chooseProject}
      >
        <div className="flex min-h-0 flex-1">
          <TicketSidebar
            onOpenTicket={openTicket}
            canOpenTicket={canOpenTicket}
            onCloseTicket={requestCloseTicket}
            showCodeDiscovery={showCodeDiscovery}
            onLearnMoreCode={(url) => void window.pm.openExternal(url)}
            onDismissCodeDiscovery={dismissCodeDiscovery}
            codeDiscoveryDismissError={codeDiscoveryDismissError}
          />
          {!activeTicket ? (
            <NoTicketsEmptyState
              onOpenTicket={openTicket}
              canOpenTicket={canOpenTicket}
              showCodeDiscovery={showCodeDiscovery}
              onLearnMoreCode={(url) => void window.pm.openExternal(url)}
              onDismissCodeDiscovery={dismissCodeDiscovery}
              codeDiscoveryDismissError={codeDiscoveryDismissError}
            />
          ) : (
            <main className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(320px,5fr)_7fr]">
              <ComposerForm
                onGenerate={generate}
                issueTypes={issueTypes}
                loadingIssueTypes={issueTypesQuery.isPending}
                labels={labels}
                loadingLabels={labelsQuery.isPending}
                labelsError={labelsError}
                labelsTruncated={labelsTruncated}
                onRetryLabels={retryLabels}
                focusEditorSignal={composerFocusToken}
              />
              {/* key remounts local edit-prompt state when switching tickets */}
              <OutputPanel
                key={activeTicket.id}
                onEdit={edit}
                onCreate={create}
                onCreateSubtasks={createSubtasks}
                onOpenUrl={(url) => void window.pm.openExternal(url)}
                showCodeDiscovery={showCodeDiscovery}
                onLearnMoreCode={(url) => void window.pm.openExternal(url)}
                onDismissCodeDiscovery={dismissCodeDiscovery}
                codeDiscoveryDismissError={codeDiscoveryDismissError}
              />
            </main>
          )}
        </div>
      </ProjectWorkspaceChrome>

      <Dialog
        open={closeConfirmId !== null}
        onOpenChange={(open) => {
          if (!open) setCloseConfirmId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close ticket with work in progress?</DialogTitle>
            <DialogDescription>
              {closeConfirmTicket
                ? "An agent or tracker operation is still running on this ticket. Closing removes it from the sidebar; in-flight work will no longer be shown here (it is not cancelled on the agent side)."
                : "This ticket has an operation in progress."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCloseConfirmId(null)}>
              Keep open
            </Button>
            <Button type="button" variant="destructive" onClick={confirmCloseTicket}>
              Close anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {aboutDialog}
    </div>
  );
}
