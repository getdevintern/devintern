import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseGitHubRepoInput } from "../../../shared/github-repo.ts";
import type { GitHubRepoListItem, ProjectStatus } from "../../../shared/ipc-contract.ts";
import { qk } from "../queries/keys.ts";
import { useGitHubAuthStatus } from "../queries/useGitHubAuthStatus.ts";
import { useGitHubOAuthAvailable } from "../queries/useGitHubOAuthAvailable.ts";
import { useGitHubRepos } from "../queries/useGitHubRepos.ts";

/**
 * Normalize typed/pasted repo input into a case-insensitive substring for list filtering.
 * URLs become `owner/repo`; freeform text is lowercased as-is. Empty → no filter.
 */
export function repoListFilterQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const parsed = parseGitHubRepoInput(trimmed);
  return (parsed?.slug ?? trimmed).toLowerCase();
}

/** Filter already-loaded repos by substring match on `fullName` (case-insensitive). */
export function filterGitHubRepos(
  repos: GitHubRepoListItem[],
  repoInput: string,
): GitHubRepoListItem[] {
  const query = repoListFilterQuery(repoInput);
  if (!query) return repos;
  return repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
}

/** Stable empty list so `reposQuery.data ?? …` does not allocate every render. */
const EMPTY_GITHUB_REPOS: GitHubRepoListItem[] = [];

interface ConnectGitHubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with project status after a successful managed clone + load. */
  onConnected: (status: ProjectStatus) => void;
}

/**
 * Primary Connect flow: optional auth → paste/pick owner/repo → managed clone.
 * Auth defaults to "Sign in with GitHub" (OAuth device flow); PAT is an advanced
 * fallback for power users / CI-like setups.
 */
export function ConnectGitHubDialog({ open, onOpenChange, onConnected }: ConnectGitHubDialogProps) {
  const queryClient = useQueryClient();
  const [oauthRunning, setOauthRunning] = useState(false);
  const [oauthPrompt, setOauthPrompt] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const [needsInstall, setNeedsInstall] = useState(false);
  const [token, setToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [repoInput, setRepoInput] = useState("");
  const [branch, setBranch] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [showPat, setShowPat] = useState(false);

  const oauthAvailableQuery = useGitHubOAuthAvailable(open);
  const authStatusQuery = useGitHubAuthStatus(open);
  const authConnected = authStatusQuery.data?.connected ?? false;
  const authMethod = authStatusQuery.data?.method;
  const oauthAvailable = oauthAvailableQuery.data ?? false;
  const reposQuery = useGitHubRepos(open && authConnected);
  // Stable empty fallback so useMemo deps don't churn every render when data is undefined.
  const repos = reposQuery.data ?? EMPTY_GITHUB_REPOS;
  const loadingRepos = reposQuery.isPending;

  // Reset transient dialog state when opening; clear stale errors so a reopen
  // after a failed connect doesn't carry the old message.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNeedsAuth(false);
    setToken("");
    setRepoInput("");
    setBranch("");
    setShowPat(false);
    setOauthPrompt(null);
    setNeedsInstall(false);
  }, [open]);

  // Surface repo fetch errors (auth_required / forbidden → re-auth prompt).
  useEffect(() => {
    if (!reposQuery.error) {
      setError(null);
      return;
    }
    setError(reposQuery.error.message);
    if (reposQuery.error.code === "auth_required" || reposQuery.error.code === "forbidden") {
      setNeedsAuth(true);
    }
  }, [reposQuery.error]);

  // After OAuth, an empty installation-backed list means the app isn't
  // installed (or the user can't see any installation repos) — offer install.
  useEffect(() => {
    setNeedsInstall(authMethod === "oauth" && reposQuery.isSuccess && repos.length === 0);
  }, [authMethod, reposQuery.isSuccess, repos.length]);

  // Surface the device-flow user code while polling runs.
  useEffect(() => {
    return window.pm.onGitHubOAuthPrompt((prompt) => {
      setOauthPrompt(prompt);
    });
  }, []);

  const reloadRepos = () => {
    void queryClient.invalidateQueries({ queryKey: qk.githubRepos });
  };

  const onSignInWithGitHub = async () => {
    setOauthRunning(true);
    setError(null);
    setOauthPrompt(null);
    try {
      const result = await window.pm.startGitHubOAuth();
      if (!result.ok) {
        if (result.error.code !== "cancelled") {
          setError(result.error.message);
        }
        return;
      }
      // Refresh auth status + repos from the shared cache.
      await queryClient.invalidateQueries({ queryKey: qk.githubAuthStatus });
      await queryClient.invalidateQueries({ queryKey: qk.githubRepos });
      setNeedsAuth(false);
    } finally {
      setOauthRunning(false);
      setOauthPrompt(null);
    }
  };

  const onSaveToken = async () => {
    setSavingToken(true);
    setError(null);
    try {
      const result = await window.pm.setGitHubToken(token);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setToken("");
      setNeedsAuth(false);
      setShowPat(false);
      // Refresh auth status + repos from the shared cache.
      await queryClient.invalidateQueries({ queryKey: qk.githubAuthStatus });
      await queryClient.invalidateQueries({ queryKey: qk.githubRepos });
    } finally {
      setSavingToken(false);
    }
  };

  const onConnect = async () => {
    if (!repoInput.trim()) {
      setError("Enter a repository as owner/repo.");
      return;
    }
    setConnecting(true);
    setError(null);
    setNeedsAuth(false);
    try {
      const result = await window.pm.connectGitHubRepo({
        repoInput: repoInput.trim(),
        branch: branch.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error.message);
        if (result.error.code === "auth_required" || result.error.code === "forbidden") {
          setNeedsAuth(true);
        }
        return;
      }
      onConnected(result.value);
      onOpenChange(false);
    } finally {
      setConnecting(false);
    }
  };

  const authRequired = needsAuth || !authConnected;
  const showAuthBlock = authRequired || showPat;

  const filteredRepos = useMemo(() => filterGitHubRepos(repos, repoInput), [repos, repoInput]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="connect-github-dialog">
        <DialogHeader>
          <DialogTitle>Connect GitHub repository</DialogTitle>
          <DialogDescription>
            Type to filter your repos, or paste an owner/repo (or github.com URL). The app clones it
            into a managed folder and runs setup there — you do not pick a path.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {showAuthBlock ? (
            <div className="space-y-3 rounded-md border p-3" data-testid="connect-github-auth">
              {oauthAvailable && authRequired ? (
                <div className="space-y-2" data-testid="connect-github-oauth">
                  <Label className="text-sm">Sign in to GitHub</Label>
                  {oauthRunning && oauthPrompt ? (
                    <div className="space-y-3" data-testid="connect-github-oauth-code">
                      <p className="text-xs text-muted-foreground">
                        Enter this code on GitHub to authorize DevIntern PM:
                      </p>
                      <div className="flex items-center gap-2">
                        <code
                          className="select-all rounded-md border bg-muted px-3 py-2 font-mono text-lg tracking-widest"
                          data-testid="connect-github-user-code"
                        >
                          {oauthPrompt.userCode}
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void navigator.clipboard?.writeText(oauthPrompt.userCode)}
                          data-testid="connect-github-copy-code"
                        >
                          Copy
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        A browser tab opened to {oauthPrompt.verificationUri}. If it closed, open it
                        again below.
                      </p>
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto px-0 text-xs"
                        onClick={() => void window.pm.openExternal(oauthPrompt.verificationUri)}
                      >
                        Open GitHub sign-in page
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Authorize the DevIntern PM app to access your repositories. Opens your
                        browser — no token to paste.
                      </p>
                      <Button
                        type="button"
                        disabled={oauthRunning}
                        onClick={() => void onSignInWithGitHub()}
                        data-testid="connect-github-sign-in"
                      >
                        {oauthRunning ? <Loader2 className="animate-spin" /> : <GitPullRequest />}
                        {oauthRunning ? "Waiting for browser…" : "Sign in with GitHub"}
                      </Button>
                    </>
                  )}
                  {oauthRunning ? (
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto px-0 text-xs"
                        onClick={() => void window.pm.cancelGitHubOAuth()}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto px-0 text-xs"
                        onClick={() => setShowPat(true)}
                      >
                        Use a personal access token instead
                      </Button>
                    </div>
                  )}
                </div>
              ) : null}

              {showPat || !oauthAvailable ? (
                <div className="space-y-2" data-testid="connect-github-pat">
                  <Label htmlFor="github-token" className="text-sm">
                    GitHub personal access token
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Required for private repos. Fine-grained: Contents Read (and Metadata). Classic:
                    repo scope. Stored only on this machine (encrypted when the OS supports it).
                  </p>
                  <div className="flex gap-2">
                    <Input
                      id="github-token"
                      type="password"
                      autoComplete="off"
                      placeholder="ghp_… or github_pat_…"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      disabled={savingToken || connecting}
                      data-testid="connect-github-token"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={savingToken || connecting || !token.trim()}
                      onClick={() => void onSaveToken()}
                      data-testid="connect-github-save-token"
                    >
                      {savingToken ? <Loader2 className="animate-spin" /> : "Save"}
                    </Button>
                  </div>
                  {oauthAvailable && authRequired && !showPat ? (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto px-0 text-xs"
                      onClick={() => setShowPat(false)}
                    >
                      Use Sign in with GitHub instead
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {authConnected && !needsAuth ? (
            <p className="text-xs text-muted-foreground" data-testid="connect-github-auth-ok">
              GitHub connected{authMethod === "oauth" ? " (Sign in with GitHub)" : " (token)"}.
              <Button
                type="button"
                variant="link"
                className="h-auto px-1 text-xs"
                onClick={() => {
                  setNeedsAuth(true);
                  setShowPat(false);
                }}
              >
                Change
              </Button>
            </p>
          ) : null}

          {needsInstall && authConnected ? (
            <div
              className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
              data-testid="connect-github-needs-install"
            >
              <p className="text-xs text-foreground">
                No repositories found. Install the DevIntern PM app on your GitHub account or
                organization to access your repositories.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void window.pm.openExternal(
                    "https://github.com/apps/devintern-pm/installations/new",
                  )
                }
                data-testid="connect-github-install-app"
              >
                Install app on GitHub
              </Button>
              <p className="text-xs text-muted-foreground">
                After installing, come back here and your repositories will appear.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="github-repo" className="text-sm">
                Repository
              </Label>
              {authConnected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  disabled={loadingRepos}
                  onClick={() => reloadRepos()}
                  title="Refresh repository list"
                  data-testid="connect-github-refresh-repos"
                >
                  <RefreshCw className={loadingRepos ? "animate-spin" : ""} />
                </Button>
              ) : null}
            </div>
            <Input
              id="github-repo"
              placeholder="Search or paste owner/repo"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              disabled={connecting}
              data-testid="connect-github-repo"
            />
            {authConnected && repos.length > 0 ? (
              <div
                className="max-h-36 space-y-1 overflow-y-auto"
                data-testid="connect-github-repo-list"
              >
                {filteredRepos.length > 0 ? (
                  filteredRepos.map((repo) => (
                    <button
                      key={repo.fullName}
                      type="button"
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => {
                        // Fill owner/repo only — leave branch empty so reconnect
                        // without an explicit branch keeps the existing checkout.
                        setRepoInput(repo.fullName);
                      }}
                    >
                      <span className="truncate font-medium">{repo.fullName}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {repo.private ? "private" : "public"}
                      </span>
                    </button>
                  ))
                ) : (
                  <p
                    className="px-2 py-1.5 text-xs text-muted-foreground"
                    data-testid="connect-github-repo-filter-empty"
                  >
                    No repositories match. You can still Connect with a valid owner/repo above.
                  </p>
                )}
              </div>
            ) : null}
            {loadingRepos ? (
              <p className="text-xs text-muted-foreground">Loading your repositories…</p>
            ) : null}
            {authConnected &&
            authMethod === "oauth" &&
            !loadingRepos &&
            repos.length > 0 &&
            !repos.some((r) => r.private) ? (
              <div
                className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2"
                data-testid="connect-github-no-private-repos"
              >
                <p className="text-xs text-foreground">
                  Only public repositories are showing. To access private repos, add them to the
                  DevIntern PM app on GitHub.
                </p>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto px-0 text-xs"
                  onClick={() =>
                    void window.pm.openExternal(
                      "https://github.com/apps/devintern-pm/installations/new",
                    )
                  }
                  data-testid="connect-github-manage-access"
                >
                  Manage app access on GitHub
                </Button>
              </div>
            ) : null}
            {authConnected &&
            authMethod === "oauth" &&
            !loadingRepos &&
            repos.some((r) => r.private) ? (
              <Button
                type="button"
                variant="link"
                className="h-auto px-0 text-xs"
                onClick={() =>
                  void window.pm.openExternal(
                    "https://github.com/apps/devintern-pm/installations/new",
                  )
                }
              >
                Manage app access on GitHub
              </Button>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="github-branch" className="text-sm">
              Branch <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="github-branch"
              placeholder="Default branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={connecting}
              data-testid="connect-github-branch"
            />
          </div>

          {error ? (
            <p className="text-xs text-destructive" data-testid="connect-github-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={connecting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={connecting || !repoInput.trim()}
            onClick={() => void onConnect()}
            data-testid="connect-github-submit"
          >
            {connecting ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <GitPullRequest data-icon="inline-start" />
            )}
            {connecting ? "Cloning…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
