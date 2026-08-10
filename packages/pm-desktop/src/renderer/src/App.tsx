import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ABOUT_VERSION_UNAVAILABLE, AboutDialog } from "./components/AboutDialog.tsx";
import {
  ComposerForm,
  initialComposerValues,
  type ComposerValues,
} from "./components/ComposerForm.tsx";
import { NoTicketsEmptyState } from "./components/NoTicketsEmptyState.tsx";
import { OutputPanel } from "./components/OutputPanel.tsx";
import { ConnectGitHubDialog } from "./components/ConnectGitHubDialog.tsx";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { ProjectWorkspaceChrome } from "./components/ProjectWorkspaceChrome.tsx";
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
import { isBusy } from "./state/app-store.ts";
import {
  getActiveTicket,
  nextTicketId,
  ticketWorkspacesReducer,
  initialTicketWorkspacesState,
} from "./state/ticket-workspaces.ts";
import type {
  IpcError,
  LabelListResult,
  LabelRef,
  ProjectStatus,
} from "../../shared/ipc-contract.ts";
import { shouldShowCodeDiscovery } from "../../shared/code-discovery.ts";
import {
  DEFAULT_ISSUE_TYPES,
  cacheIssueTypesFromStatus,
  getDefaultIssueType,
  issueTypeIfNeedsReset,
  resolveIssueTypes,
} from "./lib/issue-types.ts";
import {
  applyLabelsFromProjectStatus,
  clearLabelCachesForKey,
  pruneSelectedLabels,
  selectionAfterLabelsFailure,
} from "./lib/labels.ts";

let requestCounter = 0;
const nextRequestId = () => `req-${++requestCounter}`;

function toError(error: IpcError | undefined): IpcError {
  return error ?? { code: "error", message: "Unknown error" };
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
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  /** True from mount through restore-last-project (or until we know there is none). */
  const [loadingProject, setLoadingProject] = useState(true);
  /** Transient error from tracker/project/harness switch or git update IPC. */
  const [chromeError, setChromeError] = useState<string | null>(null);
  const [updatingFromRemote, setUpdatingFromRemote] = useState(false);
  /** Eligible recent project dirs (most recent first); null until first IPC resolve. */
  const [recentProjects, setRecentProjects] = useState<string[] | null>(null);
  /** null until settings IPC resolves — treat as "do not show" to avoid a launch flash. */
  const [codeDiscoveryDismissed, setCodeDiscoveryDismissed] = useState<boolean | null>(null);
  const [codeDiscoveryDismissError, setCodeDiscoveryDismissError] = useState<string | null>(null);

  const [workspaces, dispatch] = useReducer(ticketWorkspacesReducer, initialTicketWorkspacesState);
  const activeTicket = getActiveTicket(workspaces);
  // KeepWorkspaces side effects need the pre-update key and open tickets without
  // expanding applyProjectStatus deps.
  const statusRef = useRef(status);
  statusRef.current = status;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  const [issueTypes, setIssueTypes] = useState<string[]>([...DEFAULT_ISSUE_TYPES]);
  const [loadingIssueTypes, setLoadingIssueTypes] = useState(false);
  const issueTypesCache = useRef(new Map<string, string[]>());

  const [labels, setLabels] = useState<LabelRef[]>([]);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [labelsTruncated, setLabelsTruncated] = useState(false);
  const [labelsReloadToken, setLabelsReloadToken] = useState(0);
  const labelsCache = useRef(new Map<string, LabelListResult>());
  /** Per-project-key label fetch failures — blocks auto-refetch until retry. */
  const labelsFailedCache = useRef(new Map<string, string>());
  const ticketsRef = useRef(workspaces.tickets);
  ticketsRef.current = workspaces.tickets;

  /** Pending close when the ticket still has an agent/operation in flight. */
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  /** In-app setup wizard for unconfigured / misconfigured projects. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** Connect GitHub → managed clone dialog. */
  const [connectOpen, setConnectOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Stream agent output into the ticket that owns the requestId (may be background).
  useEffect(() => {
    return window.pm.onAgentChunk((event) => {
      dispatch({ type: "agent-chunk", requestId: event.requestId, chunk: event.chunk });
    });
  }, []);

  useEffect(() => {
    return window.pm.onShowAbout(() => {
      setAboutOpen(true);
    });
  }, []);

  useEffect(() => {
    void window.pm
      .getAppVersion()
      .then((result) => {
        setAppVersion(result.ok ? result.value : ABOUT_VERSION_UNAVAILABLE);
      })
      .catch(() => {
        setAppVersion(ABOUT_VERSION_UNAVAILABLE);
      });
  }, []);

  useEffect(() => {
    void window.pm.isCodeDiscoveryDismissed().then((result) => {
      if (result.ok) setCodeDiscoveryDismissed(result.value);
    });
  }, []);

  const refreshRecentProjects = useCallback(async () => {
    const result = await window.pm.getRecentProjectDirs();
    // Failed fetch must leave [] (not null) so Welcome can show the empty state.
    setRecentProjects(result.ok ? result.value : []);
  }, []);

  const applyProjectStatus = useCallback(
    (next: ProjectStatus, options?: { keepWorkspaces?: boolean }) => {
      setChromeError(null);
      const prevDefaultProjectKey = statusRef.current?.defaultProjectKey;
      setStatus(next);
      statusRef.current = next;
      const types = cacheIssueTypesFromStatus(next, issueTypesCache.current);
      setIssueTypes(types);
      const {
        labels: nextLabels,
        labelsTruncated: nextLabelsTruncated,
        labelsError: nextLabelsError,
      } = applyLabelsFromProjectStatus(next, labelsCache.current, labelsFailedCache.current);
      setLabels(nextLabels);
      setLabelsTruncated(nextLabelsTruncated);
      setLabelsError(nextLabelsError);
      // Update / similar chrome refreshes keep open tickets; full project loads reset.
      if (options?.keepWorkspaces) {
        // Unconfigured after Update → clear workspaces (same as a failed load).
        if (!next.configured) {
          dispatch({ type: "project-reset" });
          return;
        }
        if (next.defaultProjectKey && next.defaultProjectKey !== prevDefaultProjectKey) {
          dispatch({ type: "default-project-changed", projectKey: next.defaultProjectKey });
        }
        // Issue-type / label lists may have changed while tickets stayed open.
        const keepUnknown = Boolean(next.supportsFreeformLabels);
        for (const ticket of workspacesRef.current.tickets) {
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
          dispatch({
            type: "composer-patched",
            id: ticket.id,
            patch: {
              ...(reset !== null ? { issueType: reset } : {}),
              ...(labelsChanged && prunedLabels ? { labels: prunedLabels } : {}),
            },
          });
        }
        return;
      }
      // Only auto-open a ticket workspace when the project is fully ready.
      // Unconfigured git folders keep an empty sidebar; non-git folders clear tickets.
      if (next.isGitRepository && next.configured) {
        dispatch({
          type: "project-loaded",
          defaultComposer: defaultComposerForProject(next, types),
        });
      } else {
        dispatch({ type: "project-reset" });
      }
    },
    [],
  );

  const loadProject = useCallback(
    async (dir: string) => {
      setLoadingProject(true);
      try {
        const result = await window.pm.getProjectStatus(dir);
        if (!result.ok) return;
        // Close setup only after a successful status load so a failed IPC call
        // does not leave a confusing intermediate UI with stale project status.
        setSetupOpen(false);
        const next = result.value;
        // Recents update in main on successful open; refresh before applying
        // status so ProjectBar never paints with a missing active recent.
        await refreshRecentProjects();
        applyProjectStatus(next);
        // Auto-open setup for git folders that still need `.devintern-pm` (choose
        // folder and restore-last-project both land here).
        if (next.isGitRepository && !next.configured) {
          setSetupOpen(true);
        }
      } finally {
        setLoadingProject(false);
      }
    },
    [applyProjectStatus, refreshRecentProjects],
  );

  const switchTracker = useCallback(
    async (trackerId: string) => {
      if (!status || status.activeTrackerId === trackerId) return;
      // Ignore while session switch, Update, or any agent run is already in progress.
      if (
        loadingProject ||
        updatingFromRemote ||
        workspaces.tickets.some((t) => isBusy(t.output.phase))
      ) {
        return;
      }
      setLoadingProject(true);
      setChromeError(null);
      try {
        const result = await window.pm.switchTracker(trackerId);
        if (!result.ok) {
          setChromeError(toError(result.error).message);
          return;
        }
        applyProjectStatus(result.value);
      } finally {
        setLoadingProject(false);
      }
    },
    [applyProjectStatus, loadingProject, status, updatingFromRemote, workspaces.tickets],
  );

  const switchProjectKey = useCallback(
    async (projectKey: string) => {
      if (!status || status.defaultProjectKey === projectKey) return;
      // Ignore while session switch, Update, or any agent run is already in progress.
      if (
        loadingProject ||
        updatingFromRemote ||
        workspaces.tickets.some((t) => isBusy(t.output.phase))
      ) {
        return;
      }
      setLoadingProject(true);
      setChromeError(null);
      try {
        const result = await window.pm.switchProjectKey(projectKey);
        if (!result.ok) {
          setChromeError(toError(result.error).message);
          return;
        }
        const next = result.value;
        setChromeError(null);
        setStatus(next);
        statusRef.current = next;
        // Project-key switches keep open tickets; only the key (and issue
        // types / labels) change. Tracker / directory loads still use applyProjectStatus.
        const types = cacheIssueTypesFromStatus(next, issueTypesCache.current);
        setIssueTypes(types);
        const {
          labels: nextLabels,
          labelsTruncated: nextLabelsTruncated,
          labelsError: nextLabelsError,
        } = applyLabelsFromProjectStatus(next, labelsCache.current, labelsFailedCache.current);
        setLabels(nextLabels);
        setLabelsTruncated(nextLabelsTruncated);
        setLabelsError(nextLabelsError);
        dispatch({ type: "default-project-changed", projectKey });
        // Clear selections that belong to the previous project's label set.
        // Use ticketsRef so tickets opened/closed during the await are included.
        // On labelsError, nextLabels is empty so selections are cleared entirely
        // (unless freeform — typed names remain valid without a catalog).
        const keepUnknown = Boolean(next.supportsFreeformLabels);
        for (const ticket of ticketsRef.current) {
          if (ticket.composer.labels.length === 0) continue;
          dispatch({
            type: "composer-patched",
            id: ticket.id,
            patch: {
              labels: pruneSelectedLabels(ticket.composer.labels, nextLabels, { keepUnknown }),
            },
          });
        }
      } finally {
        setLoadingProject(false);
      }
    },
    [loadingProject, status, updatingFromRemote, workspaces.tickets],
  );

  const switchHarness = useCallback(
    async (harnessName: string) => {
      if (!status || status.activeHarnessName === harnessName) return;
      // Ignore while session switch, Update, or any agent run is already in progress.
      if (
        loadingProject ||
        updatingFromRemote ||
        workspaces.tickets.some((t) => isBusy(t.output.phase))
      ) {
        return;
      }
      setLoadingProject(true);
      setChromeError(null);
      try {
        const result = await window.pm.switchHarness(harnessName);
        if (!result.ok) {
          setChromeError(toError(result.error).message);
          return;
        }
        // Harness switches keep open tickets; only the agent for subsequent
        // generate/edit/decompose changes. Tracker / directory loads still use
        // applyProjectStatus.
        setChromeError(null);
        setStatus(result.value);
        statusRef.current = result.value;
      } finally {
        setLoadingProject(false);
      }
    },
    [loadingProject, status, updatingFromRemote, workspaces.tickets],
  );

  // Restore last project before refreshing recents so list/record settings
  // writes cannot race on startup. Always refresh after the restore attempt
  // so a failed load still populates Welcome with other stored recents.
  // Menu-open refresh stays a separate path.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const last = await window.pm.getLastProjectDir();
        if (cancelled) return;
        if (last.ok && last.value) {
          await loadProject(last.value);
        } else {
          setLoadingProject(false);
        }
      } catch {
        if (!cancelled) setLoadingProject(false);
      }
      await refreshRecentProjects();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProject, refreshRecentProjects]);

  // Refetch issue types when the active ticket's project key changes.
  const activeTicketId = activeTicket?.id;
  const activeProjectKey = activeTicket?.composer.projectKey;
  const activeIssueType = activeTicket?.composer.issueType;
  const activeSelectedLabels = activeTicket?.composer.labels;
  useEffect(() => {
    // Skip while session/Update holds the main mutex (listIssueTypes needs `current`).
    if (loadingProject || updatingFromRemote) return;
    if (!status?.supportsIssueTypes || !activeProjectKey || !activeTicketId) return;
    const cached = issueTypesCache.current.get(activeProjectKey);
    if (cached) {
      setIssueTypes(cached);
      const reset = issueTypeIfNeedsReset(activeIssueType, cached);
      if (reset !== null) {
        dispatch({
          type: "composer-patched",
          id: activeTicketId,
          patch: { issueType: reset },
        });
      }
      return;
    }
    let cancelled = false;
    setLoadingIssueTypes(true);
    void window.pm.listIssueTypes(activeProjectKey).then((result) => {
      if (cancelled) return;
      setLoadingIssueTypes(false);
      const types = resolveIssueTypes(result.ok ? result.value : undefined);
      issueTypesCache.current.set(activeProjectKey, types);
      setIssueTypes(types);
      const reset = issueTypeIfNeedsReset(activeIssueType, types);
      if (reset !== null) {
        dispatch({
          type: "composer-patched",
          id: activeTicketId,
          patch: { issueType: reset },
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    status?.supportsIssueTypes,
    activeProjectKey,
    activeTicketId,
    activeIssueType,
    loadingProject,
    updatingFromRemote,
  ]);

  // Keep selected labels readable inside the fetch effect without re-running on
  // every chip toggle (which would loop through prune → patch → effect).
  const selectedLabelsRef = useRef<string[]>([]);
  selectedLabelsRef.current = activeSelectedLabels ?? [];

  // Refetch labels when the active ticket's project key (or capability) changes.
  useEffect(() => {
    if (!status?.supportsLabels) {
      setLabels([]);
      setLabelsTruncated(false);
      setLabelsError(null);
      setLoadingLabels(false);
      if (activeTicketId && selectedLabelsRef.current.length > 0) {
        dispatch({
          type: "composer-patched",
          id: activeTicketId,
          patch: { labels: [] },
        });
      }
      return;
    }
    // Skip while session/Update holds the main mutex (listLabels needs `current`).
    if (loadingProject || updatingFromRemote) return;
    if (!activeTicketId) return;
    // Empty string is valid for markdown (no project key); treat undefined as "".
    const projectKey = activeProjectKey ?? "";
    const freeform = Boolean(status.supportsFreeformLabels);

    const syncSelectedLabels = (catalog: LabelListResult) => {
      setLabels(catalog.labels);
      setLabelsTruncated(catalog.truncated);
      const selected = selectedLabelsRef.current;
      const pruned = pruneSelectedLabels(selected, catalog.labels, {
        keepUnknown: freeform,
      });
      if (pruned.length !== selected.length || pruned.some((id, i) => id !== selected[i])) {
        dispatch({
          type: "composer-patched",
          id: activeTicketId,
          patch: { labels: pruned },
        });
      }
    };

    const clearSelectedOnFailure = () => {
      setLabelsTruncated(false);
      const cleared = selectionAfterLabelsFailure(selectedLabelsRef.current, {
        keepOnFailure: freeform,
      });
      if (cleared !== selectedLabelsRef.current) {
        dispatch({
          type: "composer-patched",
          id: activeTicketId,
          patch: { labels: cleared },
        });
      }
    };

    const cached = labelsCache.current.get(projectKey);
    if (cached) {
      labelsFailedCache.current.delete(projectKey);
      setLabelsError(null);
      setLoadingLabels(false);
      syncSelectedLabels(cached);
      return;
    }

    const failed = labelsFailedCache.current.get(projectKey);
    if (failed) {
      setLabels([]);
      setLabelsError(failed);
      setLoadingLabels(false);
      clearSelectedOnFailure();
      return;
    }

    let cancelled = false;
    setLoadingLabels(true);
    setLabelsError(null);
    void window.pm.listLabels(projectKey || undefined).then((result) => {
      if (cancelled) return;
      setLoadingLabels(false);
      if (!result.ok) {
        const message = toError(result.error).message;
        labelsFailedCache.current.set(projectKey, message);
        setLabels([]);
        setLabelsError(message);
        clearSelectedOnFailure();
        return;
      }
      labelsFailedCache.current.delete(projectKey);
      labelsCache.current.set(projectKey, result.value);
      syncSelectedLabels(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [
    status?.supportsLabels,
    status?.supportsFreeformLabels,
    activeProjectKey,
    activeTicketId,
    labelsReloadToken,
    loadingProject,
    updatingFromRemote,
  ]);

  const retryLabels = useCallback(() => {
    if (!activeProjectKey) return;
    clearLabelCachesForKey(labelsCache.current, labelsFailedCache.current, activeProjectKey);
    setLabelsReloadToken((token) => token + 1);
  }, [activeProjectKey]);

  const chooseProject = async () => {
    // Ignore while session switch, Update, or any agent run is already in progress.
    if (
      loadingProject ||
      updatingFromRemote ||
      workspaces.tickets.some((t) => isBusy(t.output.phase))
    ) {
      return;
    }
    const result = await window.pm.chooseProjectDir();
    if (result.ok && result.value) {
      await loadProject(result.value);
    }
  };

  const openConnectGitHub = useCallback(() => {
    if (
      loadingProject ||
      updatingFromRemote ||
      workspaces.tickets.some((t) => isBusy(t.output.phase))
    ) {
      return;
    }
    // Defer past DropdownMenu dismissable-layer cleanup. Opening Dialog in the
    // same tick inherits body { pointer-events: none } and leaves the UI frozen
    // after close (Radix #3317 / #837).
    window.setTimeout(() => setConnectOpen(true), 0);
  }, [loadingProject, updatingFromRemote, workspaces.tickets]);

  const onGitHubConnected = useCallback(
    async (next: ProjectStatus) => {
      setLoadingProject(true);
      try {
        setSetupOpen(false);
        await refreshRecentProjects();
        applyProjectStatus(next);
        if (next.isGitRepository && !next.configured) {
          setSetupOpen(true);
        }
      } finally {
        setLoadingProject(false);
      }
    },
    [applyProjectStatus, refreshRecentProjects],
  );

  const onProjectRemoved = useCallback(() => {
    setStatus(null);
    statusRef.current = null;
    dispatch({ type: "project-reset" });
    setSetupOpen(false);
    setChromeError(null);
    void refreshRecentProjects();
  }, [refreshRecentProjects]);

  const openRecentProject = useCallback(
    async (dir: string) => {
      if (
        loadingProject ||
        updatingFromRemote ||
        workspaces.tickets.some((t) => isBusy(t.output.phase))
      ) {
        return;
      }
      if (status?.projectDir === dir) return;
      await loadProject(dir);
    },
    [loadProject, loadingProject, status?.projectDir, updatingFromRemote, workspaces.tickets],
  );

  const onRecentMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) void refreshRecentProjects();
    },
    [refreshRecentProjects],
  );

  const onSetupComplete = useCallback(
    (next: ProjectStatus) => {
      // Refresh then apply so status + recents commit in one paint.
      void (async () => {
        await refreshRecentProjects();
        applyProjectStatus(next);
        setSetupOpen(false);
      })();
    },
    [applyProjectStatus, refreshRecentProjects],
  );

  const updateFromRemote = useCallback(async () => {
    if (!status?.isGitRepository) return;
    if (
      loadingProject ||
      updatingFromRemote ||
      workspaces.tickets.some((t) => isBusy(t.output.phase))
    ) {
      return;
    }
    setUpdatingFromRemote(true);
    setChromeError(null);
    try {
      const result = await window.pm.updateProjectFromRemote();
      if (!result.ok) {
        setChromeError(toError(result.error).message);
        return;
      }
      // Keep open tickets; refresh chrome + issue types (main reloaded the session).
      applyProjectStatus(result.value, { keepWorkspaces: true });
    } finally {
      setUpdatingFromRemote(false);
    }
  }, [applyProjectStatus, loadingProject, status, updatingFromRemote, workspaces.tickets]);

  const canOpenTicket = Boolean(status?.isGitRepository && status.configured);

  const openTicket = useCallback(() => {
    // Only fully ready projects (git + configured PM) should open ticket workspaces.
    if (!canOpenTicket || !status) return;
    const composer = defaultComposerForProject(status, issueTypes);
    dispatch({ type: "ticket-opened", id: nextTicketId(), composer });
  }, [canOpenTicket, status, issueTypes]);

  const dismissCodeDiscovery = useCallback(async () => {
    setCodeDiscoveryDismissError(null);
    const result = await window.pm.dismissCodeDiscovery();
    if (result.ok) {
      setCodeDiscoveryDismissed(true);
      return;
    }
    setCodeDiscoveryDismissed(false);
    setCodeDiscoveryDismissError(toError(result.error).message);
  }, []);

  const requestCloseTicket = useCallback(
    (id: string) => {
      const ticket = workspaces.tickets.find((t) => t.id === id);
      if (!ticket) return;
      if (isBusy(ticket.output.phase)) {
        setCloseConfirmId(id);
        return;
      }
      dispatch({ type: "ticket-closed", id });
    },
    [workspaces.tickets],
  );

  const confirmCloseTicket = () => {
    if (!closeConfirmId) return;
    dispatch({ type: "ticket-closed", id: closeConfirmId });
    setCloseConfirmId(null);
  };

  const patchActiveComposer = useCallback(
    (patch: Partial<ComposerValues>) => {
      if (!activeTicket) return;
      dispatch({ type: "composer-patched", id: activeTicket.id, patch });
    },
    [activeTicket],
  );

  const generate = async () => {
    if (!activeTicket) return;
    const ticketId = activeTicket.id;
    const values = activeTicket.composer;
    const content = values.sourceContent[values.sourceType];
    // Ignore while session reload / Update is tearing down `current`.
    if (
      !content.trim() ||
      isBusy(activeTicket.output.phase) ||
      loadingProject ||
      updatingFromRemote
    ) {
      return;
    }
    const requestId = nextRequestId();
    dispatch({
      type: "output-action",
      id: ticketId,
      action: { type: "generate-started", requestId },
    });
    const result = await window.pm.generateStory(requestId, {
      source: { type: values.sourceType, content },
      promptStyle: values.promptStyle,
      epicKey: values.epicKey || undefined,
      extraInstructions: values.extraInstructions || undefined,
      attachments: values.attachments.length > 0 ? values.attachments : undefined,
    });
    // Always target ticketId — user may have switched away while generating.
    if (result.ok) {
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "generate-succeeded", draft: result.value },
      });
    } else {
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "request-failed", error: toError(result.error) },
      });
    }
  };

  const edit = async (editPrompt: string) => {
    if (!activeTicket?.output.draft) return;
    // Ignore while session reload / Update is tearing down `current`.
    if (loadingProject || updatingFromRemote || isBusy(activeTicket.output.phase)) return;
    const ticketId = activeTicket.id;
    const draft = activeTicket.output.draft;
    const issueType = activeTicket.composer.issueType;
    const requestId = nextRequestId();
    dispatch({
      type: "output-action",
      id: ticketId,
      action: { type: "edit-started", requestId },
    });
    const result = await window.pm.editStory(requestId, {
      current: draft,
      editPrompt,
      issueType,
    });
    if (result.ok) {
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "edit-succeeded", draft: result.value },
      });
    } else {
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "request-failed", error: toError(result.error) },
      });
    }
  };

  const create = async () => {
    if (!activeTicket?.output.draft) return;
    // Ignore while session reload / Update is tearing down `current`, or ticket is busy.
    // isBusy blocks double-clicks before React re-renders create-started.
    if (loadingProject || updatingFromRemote || isBusy(activeTicket.output.phase)) return;
    const ticketId = activeTicket.id;
    const values = activeTicket.composer;
    const draft = activeTicket.output.draft;
    // Hold the main-process agent lock across create + optional decompose so a
    // context switch cannot sneak into the gap between those IPCs.
    const flowRequestId = `create-flow:${nextRequestId()}`;
    dispatch({ type: "output-action", id: ticketId, action: { type: "create-started" } });
    const hold = await window.pm.beginAgentRequest(flowRequestId);
    if (!hold.ok) {
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "request-failed", error: toError(hold.error) },
      });
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
          status?.supportsLabels &&
          values.labels.length > 0 &&
          (!labelsError || status.supportsFreeformLabels)
            ? values.labels
            : undefined,
        attachments: values.attachments.length > 0 ? values.attachments : undefined,
      });
      if (!result.ok) {
        dispatch({
          type: "output-action",
          id: ticketId,
          action: { type: "request-failed", error: toError(result.error) },
        });
        return;
      }
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "create-succeeded", created: result.value },
      });

      if (values.decompose) {
        const requestId = nextRequestId();
        dispatch({
          type: "output-action",
          id: ticketId,
          action: { type: "decompose-started", requestId },
        });
        const decomposed = await window.pm.decomposeStory(requestId, {
          story: draft,
          sourceType: values.sourceType,
          promptStyle: values.promptStyle,
        });
        if (decomposed.ok) {
          dispatch({
            type: "output-action",
            id: ticketId,
            action: { type: "decompose-succeeded", subtasks: decomposed.value },
          });
        } else {
          dispatch({
            type: "output-action",
            id: ticketId,
            action: { type: "request-failed", error: toError(decomposed.error) },
          });
        }
      }
    } finally {
      await window.pm.endAgentRequest(flowRequestId);
    }
  };

  const createSubtasks = async () => {
    if (!activeTicket?.output.created) return;
    // Ignore while session reload / Update is tearing down `current`, or ticket is busy.
    if (loadingProject || updatingFromRemote || isBusy(activeTicket.output.phase)) return;
    const ticketId = activeTicket.id;
    const parentKey = activeTicket.output.created.key;
    const output = activeTicket.output;
    const projectKey = activeTicket.composer.projectKey || undefined;
    const selected = output.subtasks.filter((_, i) => output.selectedSubtasks.has(i));
    dispatch({
      type: "output-action",
      id: ticketId,
      action: { type: "create-subtasks-started" },
    });
    const result = await window.pm.createSubtasks(parentKey, selected, projectKey);
    if (result.ok) {
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "create-subtasks-finished", outcomes: result.value },
      });
    } else {
      dispatch({
        type: "output-action",
        id: ticketId,
        action: { type: "request-failed", error: toError(result.error) },
      });
    }
  };

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
      </>
    );
  }

  const busy = activeTicket ? isBusy(activeTicket.output.phase) : false;
  const anyTicketBusy = workspaces.tickets.some((ticket) => isBusy(ticket.output.phase));
  const anyAgentRunning = workspaces.tickets.some((t) => isBusy(t.output.phase));
  // Same policy as ProjectBar contextBusy — block composer while Update holds the mutex.
  const contextBusy = loadingProject || updatingFromRemote;
  const closeConfirmTicket = closeConfirmId
    ? workspaces.tickets.find((t) => t.id === closeConfirmId)
    : null;
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
        status={status}
        onConnectGitHub={openConnectGitHub}
        onChangeProject={chooseProject}
        recentProjects={recentProjects ?? []}
        onOpenRecentProject={openRecentProject}
        onRecentMenuOpenChange={onRecentMenuOpenChange}
        onSwitchTracker={switchTracker}
        onSwitchProjectKey={switchProjectKey}
        onSwitchHarness={switchHarness}
        onUpdateFromRemote={updateFromRemote}
        switching={loadingProject}
        agentRunning={anyAgentRunning}
        updatingFromRemote={updatingFromRemote}
        onProjectRemoved={onProjectRemoved}
      />
      <ConnectGitHubDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(next) => void onGitHubConnected(next)}
      />
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
            tickets={workspaces.tickets}
            activeTicketId={workspaces.activeTicketId}
            onOpenTicket={openTicket}
            canOpenTicket={canOpenTicket}
            onActivateTicket={(id) => dispatch({ type: "ticket-activated", id })}
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
                status={status}
                values={activeTicket.composer}
                onChange={patchActiveComposer}
                onGenerate={generate}
                busy={busy || contextBusy}
                issueTypes={issueTypes}
                loadingIssueTypes={loadingIssueTypes}
                labels={labels}
                loadingLabels={loadingLabels}
                labelsError={labelsError}
                labelsTruncated={labelsTruncated}
                onRetryLabels={retryLabels}
              />
              {/* key remounts local edit-prompt state when switching tickets */}
              <OutputPanel
                key={activeTicket.id}
                output={activeTicket.output}
                issueType={activeTicket.composer.issueType}
                decompose={activeTicket.composer.decompose}
                busy={busy || contextBusy}
                onTitleChange={(summary) =>
                  dispatch({
                    type: "output-action",
                    id: activeTicket.id,
                    action: { type: "draft-title-changed", summary },
                  })
                }
                onDescriptionChange={(description) =>
                  dispatch({
                    type: "output-action",
                    id: activeTicket.id,
                    action: { type: "draft-description-changed", description },
                  })
                }
                onEdit={edit}
                onCreate={create}
                onToggleSubtask={(index) =>
                  dispatch({
                    type: "output-action",
                    id: activeTicket.id,
                    action: { type: "subtask-toggled", index },
                  })
                }
                onCreateSubtasks={createSubtasks}
                onSkipSubtasks={() =>
                  dispatch({
                    type: "output-action",
                    id: activeTicket.id,
                    action: { type: "subtasks-skipped" },
                  })
                }
                onRestart={() =>
                  dispatch({
                    type: "output-action",
                    id: activeTicket.id,
                    action: { type: "restarted" },
                  })
                }
                onDismissError={() =>
                  dispatch({
                    type: "output-action",
                    id: activeTicket.id,
                    action: { type: "error-dismissed" },
                  })
                }
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

      <AboutDialog
        open={aboutOpen}
        onOpenChange={setAboutOpen}
        version={appVersion}
        onOpenWebsite={(url) => void window.pm.openExternal(url)}
      />
    </div>
  );
}
