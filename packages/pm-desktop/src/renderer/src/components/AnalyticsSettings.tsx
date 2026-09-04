import { FolderOpen, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectBindingInfo } from "../../../shared/project-binding.ts";
import type { QuickCaptureConfig } from "../../../shared/quick-capture.ts";
import {
  QUICK_CAPTURE_DEFAULT_LABEL,
  acceleratorFromKeyboardEvent,
  isValidAcceleratorShape,
  prettyAccelerator,
  resolveQuickCaptureAccelerator,
} from "../../../shared/quick-capture.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { qk } from "../queries/keys.ts";
import { useAnalyticsEnabled } from "../queries/useAnalyticsEnabled.ts";
import { useGitHubAuthStatus } from "../queries/useGitHubAuthStatus.ts";
import { useQuickCaptureStatus } from "../queries/useQuickCaptureStatus.ts";

interface AnalyticsSettingsProps {
  /** Current project path (for disk settings). */
  projectDir?: string | null;
  /** Binding for managed clone path / remove. */
  projectBinding?: ProjectBindingInfo | null;
  /** Called after a managed project is removed so the UI can return to Welcome. */
  onProjectRemoved?: () => void;
  /** Disable Remove while an agent request is in flight. */
  agentRunning?: boolean;
  /** Disable Remove while update-from-remote is in flight. */
  updatingFromRemote?: boolean;
  /** Active `AGENT_MODEL` override for the project, when set. */
  activeModel?: string;
  /**
   * Persist `AGENT_MODEL` for the project and reload the session. Resolves
   * with an error message on failure, or null on success. Omitted when no PM
   * project is open (model is a per-project setting).
   */
  onSwitchModel?: (model: string) => Promise<string | null>;
}

export function AnalyticsSettings({
  projectDir = null,
  projectBinding = null,
  onProjectRemoved,
  agentRunning = false,
  updatingFromRemote = false,
  activeModel,
  onSwitchModel,
}: AnalyticsSettingsProps = {}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [clearingToken, setClearingToken] = useState(false);
  const [confirmClearToken, setConfirmClearToken] = useState(false);
  const [githubTokenError, setGithubTokenError] = useState<string | null>(null);
  const [modelInput, setModelInput] = useState(activeModel ?? "");
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  /** Quick Capture local state: enabled flag + custom binding (null = default). */
  const [quickCaptureOn, setQuickCaptureOn] = useState(false);
  const [quickCaptureShortcut, setQuickCaptureShortcut] = useState<string | null>(null);
  const [quickCaptureSaving, setQuickCaptureSaving] = useState(false);
  const [quickCaptureActionError, setQuickCaptureActionError] = useState<string | null>(null);
  const [recordingShortcut, setRecordingShortcut] = useState(false);

  const analyticsQuery = useAnalyticsEnabled(open);
  const githubAuthQuery = useGitHubAuthStatus(open);
  const quickCaptureQuery = useQuickCaptureStatus(open);
  const githubConnected = githubAuthQuery.data?.connected ?? false;
  const githubAuthMethod = githubAuthQuery.data?.method;
  const githubLogin = githubAuthQuery.data?.login;
  const githubTokenEncrypted = githubAuthQuery.data
    ? githubAuthQuery.data.connected
      ? (githubAuthQuery.data.tokenEncrypted ?? false)
      : null
    : null;

  const removeBlocked = agentRunning || updatingFromRemote;

  // Seed the analytics toggle from the shared cache when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setGithubTokenError(null);
    setConfirmClearToken(false);
    setModelError(null);
    setModelInput(activeModel ?? "");
    setRecordingShortcut(false);
    setQuickCaptureActionError(null);
    if (analyticsQuery.data !== undefined) {
      setEnabled(analyticsQuery.data);
    }
  }, [open, analyticsQuery.data, activeModel]);

  // Seed Quick Capture controls from the status snapshot each time it lands.
  useEffect(() => {
    if (!open || !quickCaptureQuery.data) return;
    const status = quickCaptureQuery.data;
    setQuickCaptureOn(status.enabled);
    setQuickCaptureShortcut(
      status.shortcut === resolveQuickCaptureAccelerator(null) ? null : status.shortcut,
    );
    setQuickCaptureActionError(status.error ?? null);
  }, [open, quickCaptureQuery.data]);

  const onCheckedChange = (next: boolean) => {
    setLoading(true);
    setError(null);
    const previous = enabled;
    setEnabled(next);
    void window.pm.setAnalyticsEnabled(next).then((result) => {
      setLoading(false);
      if (!result.ok) {
        setEnabled(previous);
        setError(result.error.message);
        return;
      }
      // Keep the shared analytics cache in sync.
      queryClient.setQueryData(qk.analyticsEnabled, next);
    });
  };

  const onSaveModel = () => {
    if (!onSwitchModel) return;
    if (modelInput.trim() === (activeModel ?? "")) return;
    setSavingModel(true);
    setModelError(null);
    void onSwitchModel(modelInput).then((errorMessage) => {
      setSavingModel(false);
      if (errorMessage) setModelError(errorMessage);
    });
  };

  const diskPath = projectBinding?.localPath ?? projectDir;
  const isManaged = projectBinding?.managed === true;

  const onReveal = () => {
    if (!diskPath) return;
    setProjectActionError(null);
    void window.pm.revealProjectInFolder(diskPath).then((result) => {
      if (!result.ok) setProjectActionError(result.error.message);
    });
  };

  const onRemove = () => {
    if (!diskPath || !isManaged) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setRemoving(true);
    setProjectActionError(null);
    void window.pm
      .removeConnectedProject({ localPath: diskPath, deleteFiles: true })
      .then((result) => {
        setRemoving(false);
        if (!result.ok) {
          setProjectActionError(result.error.message);
          return;
        }
        setConfirmRemove(false);
        setOpen(false);
        onProjectRemoved?.();
      });
  };

  const onClearGitHubToken = () => {
    if (!githubConnected) return;
    if (!confirmClearToken) {
      setConfirmClearToken(true);
      return;
    }
    setClearingToken(true);
    setGithubTokenError(null);
    void window.pm.clearGitHubToken().then((result) => {
      setClearingToken(false);
      if (!result.ok) {
        setGithubTokenError(result.error.message);
        return;
      }
      setConfirmClearToken(false);
      // Refresh the shared auth-status cache (now disconnected).
      void queryClient.invalidateQueries({ queryKey: qk.githubAuthStatus });
    });
  };

  const defaultAccelerator = resolveQuickCaptureAccelerator(null);

  /** Persist Quick Capture config and mirror the resulting status into local state. */
  const applyQuickCapture = async (next: QuickCaptureConfig) => {
    setQuickCaptureSaving(true);
    setQuickCaptureActionError(null);
    const result = await window.pm.setQuickCaptureSettings(next);
    setQuickCaptureSaving(false);
    if (!result.ok) {
      setQuickCaptureActionError(result.error.message);
      return;
    }
    queryClient.setQueryData(qk.quickCapture, result.value);
    setQuickCaptureOn(result.value.enabled);
    setQuickCaptureShortcut(
      result.value.shortcut === defaultAccelerator ? null : result.value.shortcut,
    );
    if (result.value.error) setQuickCaptureActionError(result.value.error);
  };

  const onQuickCaptureToggle = (next: boolean) => {
    void applyQuickCapture({ enabled: next, shortcut: quickCaptureShortcut });
  };

  const onRecordedShortcutKey = (event: ReactKeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecordingShortcut(false);
      return;
    }
    const accelerator = acceleratorFromKeyboardEvent({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });
    if (!accelerator || !isValidAcceleratorShape(accelerator)) return;
    setRecordingShortcut(false);
    void applyQuickCapture({ enabled: true, shortcut: accelerator });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setConfirmRemove(false);
          setConfirmClearToken(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Settings" aria-label="Settings">
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" data-testid="settings-dialog">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Preferences for this install. Stored locally on your machine.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start justify-between gap-4 py-2">
          <div className="space-y-1">
            <Label htmlFor="analytics-enabled" className="text-sm text-foreground">
              Share anonymous usage data
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Helps us understand which features are used, and reports errors so they can be fixed.
              Never includes prompts, ticket text, project paths, or credentials. You can turn this
              off anytime.
            </p>
          </div>
          <Switch
            id="analytics-enabled"
            checked={enabled}
            disabled={loading}
            onCheckedChange={onCheckedChange}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}

        {onSwitchModel ? (
          <>
            <Separator />
            <div className="space-y-3 py-1" data-testid="settings-agent-model">
              <div className="space-y-1">
                <Label htmlFor="agent-model" className="text-sm text-foreground">
                  Agent model
                </Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Model override for this project&apos;s agent harness, stored in
                  .devintern-pm/.env. The string is harness-specific (e.g. &quot;sonnet&quot; for
                  Claude Code); leave blank to use the harness default.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  id="agent-model"
                  value={modelInput}
                  placeholder="Harness default"
                  disabled={savingModel}
                  onChange={(event) => setModelInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onSaveModel();
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={savingModel || modelInput.trim() === (activeModel ?? "")}
                  data-testid="settings-save-model"
                  onClick={onSaveModel}
                >
                  {savingModel ? "Saving…" : "Save"}
                </Button>
              </div>
              {modelError ? (
                <p className="text-xs text-destructive" data-testid="settings-model-error">
                  {modelError}
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {githubConnected ? (
          <>
            <Separator />
            <div className="space-y-3 py-1" data-testid="settings-github-token">
              <div className="space-y-1">
                <Label className="text-sm text-foreground">
                  GitHub {githubAuthMethod === "oauth" ? "sign-in" : "token"}
                </Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {githubAuthMethod === "oauth"
                    ? `Signed in as ${githubLogin ?? "your GitHub account"} via the DevIntern PM app.`
                    : "A personal access token is stored under this app's data folder on this machine"}{" "}
                  {githubAuthMethod === "oauth"
                    ? ""
                    : githubTokenEncrypted === true
                      ? "(encrypted with OS keychain support)."
                      : githubTokenEncrypted === false
                        ? "(plaintext fallback — OS encryption is unavailable)."
                        : "."}{" "}
                  Disconnect to remove it.
                </p>
              </div>
              <Button
                type="button"
                variant={confirmClearToken ? "destructive" : "outline"}
                size="sm"
                disabled={clearingToken}
                data-testid="settings-clear-github-token"
                onClick={onClearGitHubToken}
              >
                {clearingToken
                  ? "Disconnecting…"
                  : confirmClearToken
                    ? "Confirm disconnect"
                    : "Disconnect GitHub"}
              </Button>
              {confirmClearToken ? (
                <p className="text-xs text-muted-foreground">
                  Removes the stored {githubAuthMethod === "oauth" ? "sign-in" : "token"}. Private
                  repos will need a new sign-in or token to connect.
                </p>
              ) : null}
              {githubTokenError ? (
                <p className="text-xs text-destructive" data-testid="settings-github-token-error">
                  {githubTokenError}
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        <Separator />
        <div className="space-y-3 py-1" data-testid="settings-quick-capture">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="quick-capture-enabled" className="text-sm text-foreground">
                Quick Capture
              </Label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Global shortcut that opens a fresh ticket workspace from any app, prefilled from
                your clipboard. Default {QUICK_CAPTURE_DEFAULT_LABEL}. Available on macOS, Windows,
                and Linux.
              </p>
            </div>
            <Switch
              id="quick-capture-enabled"
              checked={quickCaptureOn}
              disabled={quickCaptureSaving}
              onCheckedChange={onQuickCaptureToggle}
            />
          </div>
          {quickCaptureOn ? (
            recordingShortcut ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                autoFocus
                data-testid="quick-capture-recording"
                onKeyDown={onRecordedShortcutKey}
                onBlur={() => setRecordingShortcut(false)}
              >
                Press a key combination… (Esc to cancel)
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs"
                  data-testid="quick-capture-current"
                >
                  {prettyAccelerator(
                    resolveQuickCaptureAccelerator(quickCaptureShortcut),
                    /Mac|iPhone|iPad/i.test(navigator.userAgent),
                  )}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={quickCaptureSaving}
                  data-testid="quick-capture-change"
                  onClick={() => setRecordingShortcut(true)}
                >
                  Change…
                </Button>
                {quickCaptureShortcut ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={quickCaptureSaving}
                    data-testid="quick-capture-use-default"
                    onClick={() => void applyQuickCapture({ enabled: true, shortcut: null })}
                  >
                    Use default
                  </Button>
                ) : null}
              </div>
            )
          ) : null}
          {quickCaptureActionError ? (
            <p className="text-xs text-destructive" data-testid="quick-capture-error">
              {quickCaptureActionError}
            </p>
          ) : null}
        </div>

        {diskPath ? (
          <>
            <Separator />
            <div className="space-y-3 py-1" data-testid="settings-project-disk">
              <div className="space-y-1">
                <Label className="text-sm text-foreground">Project on disk</Label>
                <p
                  className="break-all font-mono text-xs leading-relaxed text-muted-foreground"
                  data-testid="settings-project-path"
                  title={diskPath}
                >
                  {diskPath}
                </p>
                {projectBinding?.remote ? (
                  <p className="text-xs text-muted-foreground">
                    Remote: {projectBinding.remote}
                    {isManaged ? " · managed clone" : ""}
                  </p>
                ) : isManaged ? (
                  <p className="text-xs text-muted-foreground">Managed clone</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Opened existing folder</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="settings-reveal-project"
                  onClick={onReveal}
                >
                  <FolderOpen data-icon="inline-start" />
                  Reveal in file manager
                </Button>
                {isManaged ? (
                  <Button
                    type="button"
                    variant={confirmRemove ? "destructive" : "outline"}
                    size="sm"
                    disabled={removing || removeBlocked}
                    title={
                      agentRunning
                        ? "Unavailable while an agent is running"
                        : updatingFromRemote
                          ? "Unavailable while getting updates"
                          : undefined
                    }
                    data-testid="settings-remove-project"
                    onClick={onRemove}
                  >
                    {removing
                      ? "Removing…"
                      : confirmRemove
                        ? "Confirm delete clone"
                        : "Remove project"}
                  </Button>
                ) : null}
              </div>
              {confirmRemove && isManaged && !removeBlocked ? (
                <p className="text-xs text-muted-foreground">
                  Deletes the managed clone from disk. Tracker secrets in that folder are removed
                  too.
                </p>
              ) : null}
              {projectActionError ? (
                <p className="text-xs text-destructive" data-testid="settings-project-error">
                  {projectActionError}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
