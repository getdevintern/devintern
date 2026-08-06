import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ABOUT_VERSION_UNAVAILABLE, AboutDialog } from "./components/AboutDialog.tsx";
import {
  ComposerForm,
  initialComposerValues,
  type ComposerValues,
} from "./components/ComposerForm.tsx";
import { NoTicketsEmptyState } from "./components/NoTicketsEmptyState.tsx";
import { OutputPanel } from "./components/OutputPanel.tsx";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { ProjectSetupWizard } from "./components/ProjectSetupWizard.tsx";
import { SetupBanner, Welcome } from "./components/SetupEmptyState.tsx";
import { TicketSidebar } from "./components/TicketSidebar.tsx";
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
import type { IpcError, ProjectStatus } from "../../shared/ipc-contract.ts";
import { shouldShowCodeDiscovery } from "../../shared/code-discovery.ts";
import {
  DEFAULT_ISSUE_TYPES,
  getDefaultIssueType,
  issueTypeIfNeedsReset,
  resolveIssueTypes,
} from "./lib/issue-types.ts";

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
  const [loadingProject, setLoadingProject] = useState(false);
  /** Transient error from tracker/project switch IPC (cleared on next successful load). */
  const [switchError, setSwitchError] = useState<string | null>(null);
  /** null until settings IPC resolves — treat as "do not show" to avoid a launch flash. */
  const [codeDiscoveryDismissed, setCodeDiscoveryDismissed] = useState<boolean | null>(null);
  const [codeDiscoveryDismissError, setCodeDiscoveryDismissError] = useState<string | null>(null);

  const [workspaces, dispatch] = useReducer(ticketWorkspacesReducer, initialTicketWorkspacesState);
  const activeTicket = getActiveTicket(workspaces);

  const [issueTypes, setIssueTypes] = useState<string[]>([...DEFAULT_ISSUE_TYPES]);
  const [loadingIssueTypes, setLoadingIssueTypes] = useState(false);
  const issueTypesCache = useRef(new Map<string, string[]>());

  /** Pending close when the ticket still has an agent/operation in flight. */
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  /** In-app setup wizard for unconfigured / misconfigured projects. */
  const [setupOpen, setSetupOpen] = useState(false);
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

  const applyProjectStatus = useCallback((next: ProjectStatus) => {
    setSwitchError(null);
    setStatus(next);
    issueTypesCache.current.clear();
    const types = resolveIssueTypes(next.issueTypes);
    setIssueTypes(types);
    if (next.defaultProjectKey) {
      issueTypesCache.current.set(next.defaultProjectKey, types);
    }
    dispatch({
      type: "project-loaded",
      defaultComposer: defaultComposerForProject(next, types),
    });
  }, []);

  const loadProject = useCallback(
    async (dir: string, options?: { openSetupIfUnconfigured?: boolean }) => {
      setLoadingProject(true);
      try {
        const result = await window.pm.getProjectStatus(dir);
        if (!result.ok) return;
        const next = result.value;
        applyProjectStatus(next);
        if (options?.openSetupIfUnconfigured && !next.configured) {
          setSetupOpen(true);
        }
      } finally {
        setLoadingProject(false);
      }
    },
    [applyProjectStatus],
  );

  const switchTracker = useCallback(
    async (trackerId: string) => {
      if (!status || status.activeTrackerId === trackerId) return;
      setLoadingProject(true);
      setSwitchError(null);
      try {
        const result = await window.pm.switchTracker(trackerId);
        if (!result.ok) {
          setSwitchError(toError(result.error).message);
          return;
        }
        applyProjectStatus(result.value);
      } finally {
        setLoadingProject(false);
      }
    },
    [applyProjectStatus, status],
  );

  const switchProjectKey = useCallback(
    async (projectKey: string) => {
      if (!status || status.defaultProjectKey === projectKey) return;
      setLoadingProject(true);
      setSwitchError(null);
      try {
        const result = await window.pm.switchProjectKey(projectKey);
        if (!result.ok) {
          setSwitchError(toError(result.error).message);
          return;
        }
        applyProjectStatus(result.value);
      } finally {
        setLoadingProject(false);
      }
    },
    [applyProjectStatus, status],
  );

  useEffect(() => {
    void (async () => {
      const last = await window.pm.getLastProjectDir();
      if (last.ok && last.value) {
        await loadProject(last.value);
      }
    })();
  }, [loadProject]);

  // Refetch issue types when the active ticket's project key changes.
  const activeTicketId = activeTicket?.id;
  const activeProjectKey = activeTicket?.composer.projectKey;
  const activeIssueType = activeTicket?.composer.issueType;
  useEffect(() => {
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
  }, [status?.supportsIssueTypes, activeProjectKey, activeTicketId, activeIssueType]);

  const chooseProject = async () => {
    const result = await window.pm.chooseProjectDir();
    if (result.ok && result.value) {
      await loadProject(result.value, { openSetupIfUnconfigured: true });
    }
  };

  const onSetupComplete = useCallback(
    (next: ProjectStatus) => {
      applyProjectStatus(next);
      setSetupOpen(false);
    },
    [applyProjectStatus],
  );

  const openTicket = useCallback(() => {
    if (!status) return;
    const composer = defaultComposerForProject(status, issueTypes);
    dispatch({ type: "ticket-opened", id: nextTicketId(), composer });
  }, [status, issueTypes]);

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
    if (!content.trim() || isBusy(activeTicket.output.phase)) return;
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
    const ticketId = activeTicket.id;
    const values = activeTicket.composer;
    const draft = activeTicket.output.draft;
    dispatch({ type: "output-action", id: ticketId, action: { type: "create-started" } });
    const result = await window.pm.createTask({
      draft,
      issueType: values.issueType,
      projectKey: values.projectKey || undefined,
      epicKey: values.epicKey || undefined,
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
  };

  const createSubtasks = async () => {
    if (!activeTicket?.output.created) return;
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
    return <Welcome onChooseProject={chooseProject} loading={loadingProject} />;
  }

  const busy = activeTicket ? isBusy(activeTicket.output.phase) : false;
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
        onChangeProject={chooseProject}
        onSwitchTracker={switchTracker}
        onSwitchProjectKey={switchProjectKey}
        switching={loadingProject}
      />
      {!status.configured && (
        <SetupBanner
          onSetup={() => setSetupOpen(true)}
          canRecoverViaTrackerSwitch={(status.configuredTrackers ?? []).some(
            (t) => t.id !== status.activeTrackerId,
          )}
        />
      )}
      <ProjectSetupWizard
        projectDir={status.projectDir}
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onComplete={onSetupComplete}
      />
      {switchError && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertTitle>Could not switch</AlertTitle>
          <AlertDescription>{switchError}</AlertDescription>
        </Alert>
      )}

      <div className="flex min-h-0 flex-1">
        <TicketSidebar
          tickets={workspaces.tickets}
          activeTicketId={workspaces.activeTicketId}
          onOpenTicket={openTicket}
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
              busy={busy}
              issueTypes={issueTypes}
              loadingIssueTypes={loadingIssueTypes}
            />
            {/* key remounts local edit-prompt state when switching tickets */}
            <OutputPanel
              key={activeTicket.id}
              output={activeTicket.output}
              issueType={activeTicket.composer.issueType}
              decompose={activeTicket.composer.decompose}
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
