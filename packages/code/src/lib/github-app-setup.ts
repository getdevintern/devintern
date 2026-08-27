/**
 * GitHub App pairing for the unattended worker.
 *
 * The wizard step in `worker init` points at the hosted App install page and
 * records the outcome next to the workspace's relay pairing
 * (`<workspace-home>/.devintern-code/github-app.json`). The record says
 * whether GitHub App events (`@mention` handling, PR comment events) are
 * enabled for the detected repository, so re-running the wizard can detect an
 * existing connection and setup summaries can remind about a skipped one.
 *
 * This is bookkeeping only: the worker itself still authenticates with
 * `GITHUB_APP_ID` + private key from the environment; nothing secret is
 * stored in this file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

/** Hosted DevIntern AI GitHub App (same install target as `worker connect`). */
export const GITHUB_APP_INSTALL_URL = "https://github.com/apps/devintern-ai";

export interface GitHubAppRecord {
  /** `owner/name` slug of the repository the step ran for. */
  repo: string;
  /** Whether GitHub App events are enabled (installed + connected). */
  enabled: boolean;
  /** When the pairing was confirmed (ISO timestamp); absent when skipped. */
  connectedAt?: string;
  /** When this record was last written (ISO timestamp; set by the saver). */
  recordedAt?: string;
}

function githubAppRecordPath(workingDir: string): string {
  return join(resolve(workingDir, ".devintern-code"), "github-app.json");
}

/**
 * Load the persisted GitHub App pairing record for a workspace home, or null
 * when the step never ran there (or the file is unreadable).
 */
export function loadGitHubAppRecord(workingDir: string = process.cwd()): GitHubAppRecord | null {
  const path = githubAppRecordPath(workingDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Partial<GitHubAppRecord>;
    if (typeof record.repo !== "string" || !record.repo) {
      return null;
    }
    return {
      repo: record.repo,
      enabled: record.enabled === true,
      connectedAt: typeof record.connectedAt === "string" ? record.connectedAt : undefined,
      recordedAt:
        typeof record.recordedAt === "string" ? record.recordedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Persist the GitHub App pairing record to `<workspace>/.devintern-code/`. */
export function saveGitHubAppRecord(
  record: GitHubAppRecord,
  workingDir: string = process.cwd(),
): void {
  const path = githubAppRecordPath(workingDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Whether GitHub App credentials are present in the environment
 * (`GITHUB_APP_ID` plus a private key path or base64 blob). Mirrors what
 * `GitHubAppAuth.fromEnvironment` accepts without reading key contents.
 */
export function hasGitHubAppCredentials(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
    (process.env.GITHUB_APP_PRIVATE_KEY_PATH || process.env.GITHUB_APP_PRIVATE_KEY_BASE64),
  );
}
