import { useEffect, useState } from "react";
import { AboutDialog } from "./components/AboutDialog.tsx";
import { ComposerForm } from "./components/ComposerForm.tsx";
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
import { queryClient } from "./lib/query-client.ts";
import { qk } from "./queries/keys.ts";
import { handleQuickCaptureEvent } from "./state/quick-capture-handler.ts";
import { useTicketWorkspacesStore } from "./state/ticket-workspaces-store.ts";
import { useAppData } from "./state/useAppData.ts";
import { useCloseTicketConfirm } from "./state/useCloseTicketConfirm.ts";
import { useProjectSession } from "./state/useProjectSession.ts";
import {
  create as createTask,
  createSubtasks,
  edit,
  generate,
  openTicket as openTicketAction,
} from "./state/ticket-actions.ts";

export function App() {
  const {
    status,
    loadingProject,
    chromeError,
    activeTicket,
    anyTicketBusy,
    appVersion,
    recentProjects,
    toolsQuery,
    toolsOk,
    toolsBlocked,
    toolsProbeFailed,
    toolsError,
    showToolsGate,
    issueTypes,
    labels,
    labelsTruncated,
    labelsError,
    issueTypesQuery,
    labelsQuery,
    retryLabels,
    showCodeDiscovery,
    canOpenTicket,
  } = useAppData();

  /**
   * Bumped on every Quick Capture invocation so the composer focuses its
   * source editor (capture lands ready-to-type).
   */
  const [composerFocusToken, setComposerFocusToken] = useState(0);
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
  // streams are untouched (a new tab is opened; nothing is closed). The
  // wiring itself lives in state/quick-capture-handler.ts (unit-tested).
  useEffect(() => {
    return window.pm.onQuickCapture((event) => {
      if (handleQuickCaptureEvent(event)) {
        // The fresh workspace landed ready-to-type: focus its source editor.
        setComposerFocusToken((token) => token + 1);
      }
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

  const {
    setupOpen,
    setSetupOpen,
    trackerSettingsOpen,
    setTrackerSettingsOpen,
    connectOpen,
    setConnectOpen,
    codeDiscoveryDismissError,
    dismissCodeDiscovery,
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
  } = useProjectSession({ toolsBlocked, toolsOk, toolsProbeFailed });

  const {
    closeConfirmId,
    setCloseConfirmId,
    closeConfirmTicket,
    requestCloseTicket,
    confirmCloseTicket,
  } = useCloseTicketConfirm();

  const handleOpenTicket = () => openTicketAction(canOpenTicket, issueTypes);
  const handleCreate = () => void createTask(labelsError);

  const aboutDialog = (
    <AboutDialog
      open={aboutOpen}
      onOpenChange={setAboutOpen}
      version={appVersion}
      onOpenWebsite={(url) => void window.pm.openExternal(url)}
    />
  );

  if (showToolsGate) {
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
        onSwitchEffort={switchEffort}
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
            onOpenTicket={handleOpenTicket}
            canOpenTicket={canOpenTicket}
            onCloseTicket={requestCloseTicket}
            showCodeDiscovery={showCodeDiscovery}
            onLearnMoreCode={(url) => void window.pm.openExternal(url)}
            onDismissCodeDiscovery={dismissCodeDiscovery}
            codeDiscoveryDismissError={codeDiscoveryDismissError}
          />
          {!activeTicket ? (
            <NoTicketsEmptyState
              onOpenTicket={handleOpenTicket}
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
                onCreate={handleCreate}
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
