import { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-contract.ts";
import type { ConnectGitHubRepoRequest } from "../../shared/ipc-contract.ts";
import { track } from "../analytics.ts";
import {
  clearGitHubToken,
  getGitHubAuthStatus,
  getGitHubToken,
  setGitHubToken,
} from "../github-auth.ts";
import { listGitHubRepos, validateGitHubToken } from "../github-api.ts";
import { isGitHubOAuthAvailable, runDeviceFlow } from "../github-oauth.ts";
import { connectManagedGitHubRepo } from "../managed-clone.ts";
import { recordRecentProjectDir } from "../recent-projects.ts";
import { loadProject } from "../session.ts";
import { updateSettings } from "../settings.ts";
import { handle } from "./register.ts";

/** AbortController for the in-flight OAuth device flow, if any. */
let oauthAbort: AbortController | null = null;

/** GitHub auth, OAuth, and managed-repo IPC handlers. */
export function registerGitHubIpcHandlers(): void {
  handle(IPC_CHANNELS.connectGitHubRepo, async (_event, input: ConnectGitHubRepoRequest) => {
    if (!input || typeof input !== "object") {
      throw Object.assign(new Error("Enter a GitHub repository as owner/repo."), {
        code: "invalid_input",
      });
    }
    if (typeof input.repoInput !== "string" || input.repoInput.trim().length === 0) {
      throw Object.assign(new Error("Enter a GitHub repository as owner/repo."), {
        code: "invalid_input",
      });
    }
    const branch =
      typeof input.branch === "string" && input.branch.trim().length > 0
        ? input.branch.trim()
        : undefined;
    const binding = await connectManagedGitHubRepo({
      repoInput: input.repoInput.trim(),
      branch,
    });
    const status = await loadProject(binding.localPath);
    await updateSettings({ lastProjectDir: status.projectDir });
    await recordRecentProjectDir(status.projectDir);
    void track("project_opened", { configured: status.configured });
    return status;
  });

  handle(IPC_CHANNELS.getGitHubAuthStatus, async () => {
    return getGitHubAuthStatus();
  });

  handle(IPC_CHANNELS.setGitHubToken, async (_event, token: string) => {
    if (typeof token !== "string" || token.trim().length === 0) {
      throw Object.assign(new Error("Paste a GitHub personal access token."), {
        code: "auth_required",
      });
    }
    const trimmed = token.trim();
    const validated = await validateGitHubToken(trimmed);
    if (!validated.ok) {
      throw Object.assign(new Error(validated.message), { code: "auth_required" });
    }
    await setGitHubToken(trimmed);
    const status = await getGitHubAuthStatus();
    return { ...status, login: validated.login };
  });

  handle(IPC_CHANNELS.clearGitHubToken, async () => {
    await clearGitHubToken();
    return null;
  });

  handle(IPC_CHANNELS.isGitHubOAuthAvailable, async () => {
    return isGitHubOAuthAvailable();
  });

  handle(IPC_CHANNELS.startGitHubOAuth, async () => {
    if (oauthAbort) {
      throw Object.assign(new Error("A sign-in is already in progress."), {
        code: "in_progress",
      });
    }
    oauthAbort = new AbortController();
    try {
      await runDeviceFlow({
        signal: oauthAbort.signal,
        onPrompt: (prompt) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
              window.webContents.send(IPC_CHANNELS.githubOAuthPrompt, prompt);
            }
          }
        },
      });
    } finally {
      oauthAbort = null;
    }
    return getGitHubAuthStatus();
  });

  handle(IPC_CHANNELS.cancelGitHubOAuth, async () => {
    oauthAbort?.abort();
    return null;
  });

  handle(IPC_CHANNELS.listGitHubRepos, async () => {
    const token = await getGitHubToken();
    return listGitHubRepos(token);
  });
}
