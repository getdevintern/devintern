/**
 * Worker-side, browser-free GitHub repository verification.
 *
 * Repositories added to `workspace.toml` (or created on GitHub) after the
 * first `devintern worker connect github` verify through the relay when they
 * fall under an installation this customer already paired, e.g. one with
 * "All repositories" access. The worker never opens a browser; anything the
 * relay cannot verify still needs `devintern worker connect github`.
 */

import { unverifiedWorkspaceRelayRepos } from "../init/worker-connect";
import type { WorkspaceConfig } from "../workspace/config";
import { verifyGitHubReposWithRelayToken } from "./connect";

export interface RelayAutoVerifyOptions {
  /** Live workspace config; reloads mutate it in place. */
  config: WorkspaceConfig;
  workspaceDir: string;
  relayUrl: string;
  relayToken: string;
  fetchImpl?: typeof fetch;
  verbose?: boolean;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Build a verifier to call at worker startup and after config reloads. It
 * contacts the relay whenever unverified workspace repositories exist (so a
 * repo the App gained access to since the last attempt verifies on the next
 * reload) and logs a result line only when it differs from the last one. It
 * never throws.
 */
export function createRelayAutoVerifier(options: RelayAutoVerifyOptions): () => Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  let lastLogged = "";
  const logOnce = (line: string) => {
    if (line === lastLogged) return;
    lastLogged = line;
    log(line);
  };
  return async () => {
    try {
      const pending = unverifiedWorkspaceRelayRepos(options.config, options.workspaceDir);
      if (pending.length === 0) return;
      const result = await verifyGitHubReposWithRelayToken({
        repos: pending,
        relayToken: options.relayToken,
        workingDir: options.workspaceDir,
        relayUrl: options.relayUrl,
        fetchImpl: options.fetchImpl,
      });
      if (result.kind === "unsupported") {
        if (options.verbose) {
          logOnce("   [relay] relay does not support browser-free GitHub verification yet.");
        }
        return;
      }
      const parts: string[] = [];
      if (result.verified.length > 0) {
        parts.push(`verified ${result.verified.map((repository) => repository.repo).join(", ")}`);
      }
      if (result.unverified.length > 0) {
        parts.push(
          `still unverified ${result.unverified.map((entry) => entry.repo).join(", ")} ` +
            "(run `devintern worker connect github`)",
        );
      }
      logOnce(`🔐 [relay] GitHub repositories: ${parts.join("; ")}`);
    } catch (error) {
      // Retry on the next startup or config reload.
      lastLogged = "";
      warn(`⚠️  [relay] GitHub repository auto-verification failed: ${(error as Error).message}`);
    }
  };
}
