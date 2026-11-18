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
 * contacts the relay only when unverified workspace repositories exist and
 * skips a repeat attempt for an unchanged set, so it logs at most one line
 * per change. It never throws.
 */
export function createRelayAutoVerifier(options: RelayAutoVerifyOptions): () => Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  let lastAttempted = "";
  return async () => {
    try {
      const pending = unverifiedWorkspaceRelayRepos(options.config, options.workspaceDir);
      const key = [...pending].sort().join(",");
      if (pending.length === 0 || key === lastAttempted) return;
      lastAttempted = key;
      const result = await verifyGitHubReposWithRelayToken({
        repos: pending,
        relayToken: options.relayToken,
        workingDir: options.workspaceDir,
        relayUrl: options.relayUrl,
        fetchImpl: options.fetchImpl,
      });
      if (result.kind === "unsupported") {
        if (options.verbose) {
          log("   [relay] relay does not support browser-free GitHub verification yet.");
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
      log(`🔐 [relay] GitHub repositories: ${parts.join("; ")}`);
    } catch (error) {
      // Retry on the next startup or config reload.
      lastAttempted = "";
      warn(`⚠️  [relay] GitHub repository auto-verification failed: ${(error as Error).message}`);
    }
  };
}
