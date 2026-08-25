/**
 * App-level Quick Capture wiring, extracted from `App.tsx` so the
 * capture → fresh-ticket-workspace flow is unit-testable without rendering.
 *
 * Main delivers a sanitized clipboard snapshot here on every global-shortcut
 * invocation. When a project is fully ready (git repository + configured PM),
 * a new ticket workspace opens prefilled from the capture and existing
 * tickets / running streams are untouched; otherwise nothing happens — the
 * window is already focused by main and the Welcome / setup path is visible.
 */

import type { QuickCaptureEvent } from "../../../shared/ipc-contract.ts";
import { DEFAULT_ISSUE_TYPES, resolveIssueTypes } from "../lib/issue-types.ts";
import { queryClient } from "../lib/query-client.ts";
import { qk } from "../queries/keys.ts";
import { composerForCapture, defaultComposerForProject } from "./composer-values.ts";
import { useProjectStore } from "./project-store.ts";
import { nextTicketId } from "./ticket-workspaces.ts";
import { useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";

/**
 * Handle one Quick Capture event outside React:
 *
 * - No configured project ready → no-op, returns false.
 * - Otherwise opens a fresh active ticket workspace prefilled from the
 *   capture (issue types come from the seeded query cache for the default
 *   project key, falling back to defaults until fetched) and returns true so
 *   callers can bump the composer focus signal.
 */
export function handleQuickCaptureEvent(event: QuickCaptureEvent): boolean {
  const current = useProjectStore.getState().status;
  // Never fail silently into a broken composer when no project is ready.
  if (!current?.isGitRepository || !current.configured) return false;

  const cachedTypes =
    queryClient.getQueryData<string[]>(
      qk.issueTypes(current.projectDir, current.defaultProjectKey ?? ""),
    ) ?? DEFAULT_ISSUE_TYPES;
  const composer = defaultComposerForProject(current, resolveIssueTypes(cachedTypes));
  useTicketWorkspacesStore
    .getState()
    .openTicket(nextTicketId(), composerForCapture(composer, event));
  return true;
}
