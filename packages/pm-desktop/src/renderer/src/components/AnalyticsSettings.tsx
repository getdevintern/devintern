import { FolderOpen, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../shared/auto-update.ts";
import type { ProjectBindingInfo } from "../../../shared/project-binding.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

function updateCheckSummary(status: UpdateStatus | null, checking: boolean): string {
  if (checking) return "Checking for updates…";
  if (!status) return "Update status unavailable.";
  if (status.phase === "disabled") {
    return "Update checks run only in packaged installs (not in development builds).";
  }
  if (status.phase === "checking") return "Checking for updates…";
  if (status.phase === "downloading") {
    const pct = status.download?.percent;
    return pct === undefined ? "Downloading update…" : `Downloading update… ${Math.floor(pct)}%`;
  }
  if (status.phase === "downloaded" && status.availableVersion) {
    return `Version ${status.availableVersion} is downloaded. Use the banner to restart and install.`;
  }
  if (status.phase === "available" && status.availableVersion) {
    return `Version ${status.availableVersion} is available. Use the banner to download and install.`;
  }
  if (status.phase === "not-available") {
    return `You're up to date (version ${status.currentVersion}).`;
  }
  if (status.phase === "error" && status.errorMessage) {
    return status.errorMessage;
  }
  return `Current version ${status.currentVersion}.`;
}

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
}

export function AnalyticsSettings({
  projectDir = null,
  projectBinding = null,
  onProjectRemoved,
  agentRunning = false,
  updatingFromRemote = false,
}: AnalyticsSettingsProps = {}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubAuthMethod, setGithubAuthMethod] = useState<"oauth" | "pat" | undefined>(undefined);
  const [githubLogin, setGithubLogin] = useState<string | undefined>(undefined);
  const [githubTokenEncrypted, setGithubTokenEncrypted] = useState<boolean | null>(null);
  const [clearingToken, setClearingToken] = useState(false);
  const [confirmClearToken, setConfirmClearToken] = useState(false);
  const [githubTokenError, setGithubTokenError] = useState<string | null>(null);

  const removeBlocked = agentRunning || updatingFromRemote;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setGithubTokenError(null);
    setConfirmClearToken(false);
    void window.pm.getAnalyticsEnabled().then((result) => {
      if (result.ok) {
        setEnabled(result.value);
      } else {
        setError(result.error.message);
      }
    });
    void window.pm.getUpdateStatus().then((result) => {
      if (result.ok) setUpdateStatus(result.value);
    });
    void window.pm.getGitHubAuthStatus().then((result) => {
      if (result.ok) {
        setGithubConnected(result.value.connected);
        setGithubAuthMethod(result.value.method);
        setGithubLogin(result.value.login);
        setGithubTokenEncrypted(
          result.value.connected ? (result.value.tokenEncrypted ?? false) : null,
        );
      }
    });
  }, [open]);

  useEffect(() => {
    return window.pm.onUpdateStatus((status) => {
      setUpdateStatus(status);
    });
  }, []);

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
      }
    });
  };

  const onCheckForUpdates = () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    void window.pm.checkForUpdates().then((result) => {
      setCheckingUpdate(false);
      if (result.ok) {
        setUpdateStatus(result.value);
      } else {
        setUpdateError(result.error.message);
      }
    });
  };

  const updatesDisabled = updateStatus?.phase === "disabled";
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
      setGithubConnected(false);
      setGithubAuthMethod(undefined);
      setGithubLogin(undefined);
      setGithubTokenEncrypted(null);
      setConfirmClearToken(false);
    });
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
              Helps us understand which features are used. Never includes prompts, ticket text,
              project paths, or credentials. You can turn this off anytime.
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

        <Separator />

        <div className="space-y-3 py-1" data-testid="settings-updates">
          <div className="space-y-1">
            <Label className="text-sm text-foreground">Updates</Label>
            <p
              className="text-xs leading-relaxed text-muted-foreground"
              data-testid="settings-update-summary"
            >
              {updateCheckSummary(updateStatus, checkingUpdate)}
            </p>
            {updateError && (
              <p className="text-xs text-destructive" data-testid="settings-update-error">
                {updateError}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checkingUpdate || updatesDisabled}
            data-testid="settings-check-updates"
            onClick={onCheckForUpdates}
          >
            {checkingUpdate ? "Checking…" : "Check for updates"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
