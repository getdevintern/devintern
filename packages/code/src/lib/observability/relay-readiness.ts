/**
 * `worker doctor` Relay row. Reads only local state (`relay.json`,
 * `github-pairing.json`), so it is safe under `--offline` and never calls the
 * relay.
 */

import { statSync } from "fs";
import { join } from "path";

import { loadPendingGitHubPairing } from "../relay/github-pairing";
import {
  describeRegistrationRef,
  describeWorkerConflicts,
  takeoverCommand,
} from "../relay/worker-identity";
import {
  hasGitHubRelayRegistration,
  loadRelayState,
  relayConfigDir,
  verifiedGitHubRelayRepositories,
} from "../relay/state";
import type { RelayWorkerIdentity } from "../relay/state";
import { gitHubSlugFromRemote } from "../workspace/config";
import type { WorkspaceConfig } from "../workspace/config";
import type { ReadinessCheck } from "./readiness";

const BASE = { id: "relay", label: "Relay" } as const;

/** GitHub repositories of the workspace that the relay is expected to deliver events for. */
function relayExpectedRepos(config: WorkspaceConfig | undefined): string[] {
  if (!config) return [];
  const slugs = config.repos
    .filter((repo) => !repo.manualOnly)
    .map((repo) => (repo.env.GITHUB_REPO ?? gitHubSlugFromRemote(repo.remote))?.toLowerCase())
    .filter((slug): slug is string => Boolean(slug));
  return [...new Set(slugs)];
}

/** When the pending pairing was recorded (file mtime), or undefined. */
function pendingSince(workspaceDir: string): string | undefined {
  try {
    return statSync(join(relayConfigDir(workspaceDir), "github-pairing.json")).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/** Relay readiness from local state only; an unreadable state file degrades to a warning. */
export function relayReadinessCheck(
  workspaceDir: string,
  config: WorkspaceConfig | undefined,
): ReadinessCheck {
  try {
    return inspectRelay(workspaceDir, config);
  } catch (error) {
    return {
      ...BASE,
      status: "warn",
      detail: `could not read relay state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function inspectRelay(workspaceDir: string, config: WorkspaceConfig | undefined): ReadinessCheck {
  const state = loadRelayState(workspaceDir);
  const pending = loadPendingGitHubPairing(workspaceDir);

  if (pending) {
    const since = pendingSince(workspaceDir);
    const expired = pending.expiresAt <= Date.now();
    return {
      ...BASE,
      status: "warn",
      detail: `pairing pending${since ? ` since ${since}` : ""}${expired ? " (expired)" : ""}`,
      hint: expired
        ? "Run `devintern worker connect github` to start a new pairing"
        : "Run `devintern worker connect github --status` to finish it",
    };
  }

  if (!state?.relayToken) {
    return {
      ...BASE,
      status: "ok",
      detail: "polling only (optional: `devintern worker connect`)",
    };
  }

  const paired = verifiedGitHubRelayRepositories(state);
  const conflicts = state.worker?.conflicts ?? [];
  if (state.worker && conflicts.length > 0) {
    return {
      ...BASE,
      status: "warn",
      detail: `worker ${state.worker.label}: ${describeWorkerConflicts(conflicts)
        .map((line) => line.replace(/; this worker does not receive.*$/, ""))
        .join("; ")} (this worker receives none of their events)`,
      hint: `Stop the other worker, or move them here: ${takeoverCommand(conflicts[0]!)}`,
    };
  }
  const uncovered = relayExpectedRepos(config).filter(
    (repo) => !hasGitHubRelayRegistration(state, repo),
  );
  if (uncovered.length > 0) {
    return {
      ...BASE,
      status: "warn",
      detail: `${state.relayUrl}: not paired for ${uncovered.join(", ")}`,
      hint: "Run `devintern worker connect github` (these repositories use polling until then)",
    };
  }
  return {
    ...BASE,
    status: "ok",
    detail: `paired, ${paired.length} GitHub ${paired.length === 1 ? "repository" : "repositories"} (${state.relayUrl})${workerSummary(state.worker)}`,
  };
}

/** `; worker <label>, owns a, b` for a registered relay worker identity. */
function workerSummary(worker: RelayWorkerIdentity | undefined): string {
  if (!worker) return "";
  const owned = worker.owned ?? [];
  return `; worker ${worker.label}, owns ${owned.length === 0 ? "nothing yet" : owned.map(describeRegistrationRef).join(", ")}`;
}
