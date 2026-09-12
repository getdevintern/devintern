/**
 * Derives the header/metadata data App renders from the stores + query cache.
 *
 * Pulled out of `App` so its complexity stays low: the component only wires
 * actions and layout, while these hooks own the read-side derivations and the
 * active-ticket metadata effects.
 */

import { useCallback, useEffect } from "react";
import { ABOUT_VERSION_UNAVAILABLE } from "../components/AboutDialog.tsx";
import { DEFAULT_ISSUE_TYPES, issueTypeIfNeedsReset } from "../lib/issue-types.ts";
import { pruneSelectedLabels, selectionAfterLabelsFailure } from "../lib/labels.ts";
import { queryClient } from "../lib/query-client.ts";
import { invalidateLabels } from "../queries/invalidate.ts";
import { useAppVersion } from "../queries/useAppVersion.ts";
import { useCodeDiscoveryDismissed } from "../queries/useCodeDiscoveryDismissed.ts";
import { useIssueTypes } from "../queries/useIssueTypes.ts";
import { useLabels } from "../queries/useLabels.ts";
import { useRecentProjects } from "../queries/useRecentProjects.ts";
import { useToolValidation } from "../queries/useToolValidation.ts";
import { useProjectStore } from "./project-store.ts";
import { useActiveTicket, useAnyTicketBusy } from "./selectors.ts";
import { useTicketWorkspacesStore } from "./ticket-workspaces-store.ts";
import { shouldShowCodeDiscovery } from "../../../shared/code-discovery.ts";
import { isToolValidationBlocking } from "../../../shared/tool-validation.ts";

function queryErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Unknown error";
}

function useAppChrome() {
  const status = useProjectStore((s) => s.status);
  const loadingProject = useProjectStore((s) => s.loadingProject);
  const updatingFromRemote = useProjectStore((s) => s.updatingFromRemote);
  const chromeError = useProjectStore((s) => s.chromeError);

  const activeTicket = useActiveTicket();
  const anyTicketBusy = useAnyTicketBusy();

  // Leaf queries (data fetching only; client state lives in the stores).
  const appVersionQuery = useAppVersion();
  const appVersion =
    appVersionQuery.data ?? (appVersionQuery.isError ? ABOUT_VERSION_UNAVAILABLE : null);
  const codeDiscoveryQuery = useCodeDiscoveryDismissed();
  const codeDiscoveryDismissed = codeDiscoveryQuery.data ?? null;
  const recentProjectsQuery = useRecentProjects();
  const recentProjects = recentProjectsQuery.data ?? null;
  const toolsQuery = useToolValidation();
  const toolsOk = toolsQuery.data?.ok === true;
  const toolsBlocked = isToolValidationBlocking(toolsQuery.data);
  const toolsProbeFailed = toolsQuery.isError && !toolsOk;
  const toolsError = toolsProbeFailed ? queryErrorMessage(toolsQuery.error) : null;
  const showToolsGate = !toolsOk && (toolsQuery.isPending || toolsBlocked || toolsProbeFailed);

  const showCodeDiscovery =
    codeDiscoveryDismissed !== null &&
    shouldShowCodeDiscovery({
      configured: status?.configured ?? false,
      hasCodeConfig: status?.hasCodeConfig === true,
      dismissed: codeDiscoveryDismissed,
    });
  const canOpenTicket = Boolean(status?.isGitRepository && status.configured);

  return {
    status,
    loadingProject,
    updatingFromRemote,
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
    showCodeDiscovery,
    canOpenTicket,
  };
}

function useTicketMetadata() {
  const status = useProjectStore((s) => s.status);
  const loadingProject = useProjectStore((s) => s.loadingProject);
  const updatingFromRemote = useProjectStore((s) => s.updatingFromRemote);
  const activeTicket = useActiveTicket();

  // Active-ticket derivations used by the metadata hooks + composer pruning.
  const activeTicketId = activeTicket?.id;
  const activeProjectKey = activeTicket?.composer.projectKey;
  const activeIssueType = activeTicket?.composer.issueType;
  const projectDir = status?.projectDir ?? null;

  // Tracker-scoped queries (issue types + labels). Keys are scoped by dir +
  // projectKey so switching project dirs uses distinct cache entries. The
  // default-key cache is seeded from ProjectStatus by seedProjectStatusCaches.
  const metadataEnabled = !loadingProject && !updatingFromRemote && !!activeTicketId;
  const issueTypesQuery = useIssueTypes(
    projectDir,
    activeProjectKey ?? null,
    Boolean(status?.supportsIssueTypes) && metadataEnabled,
  );
  const labelsQuery = useLabels(
    projectDir,
    activeProjectKey ?? null,
    Boolean(status?.supportsLabels) && metadataEnabled,
  );
  // Stable fallback reference — spreading would allocate a new array every render.
  const issueTypes = issueTypesQuery.data ?? DEFAULT_ISSUE_TYPES;
  const labels = labelsQuery.data?.labels ?? [];
  const labelsTruncated = labelsQuery.data?.truncated ?? false;
  const labelsError = labelsQuery.error ? labelsQuery.error.message : null;

  // Reset the active ticket's issue type when the available list changes and
  // the current selection is no longer valid.
  useEffect(() => {
    if (!activeTicketId || !issueTypesQuery.data) return;
    const reset = issueTypeIfNeedsReset(activeIssueType, issueTypesQuery.data);
    if (reset !== null) {
      useTicketWorkspacesStore.getState().patchComposer(activeTicketId, { issueType: reset });
    }
  }, [activeTicketId, activeIssueType, issueTypesQuery.data]);

  // Prune the active ticket's selected labels when the label catalog changes
  // (new project key, refetch, capability toggle) or when labels fail to load.
  // Reads the current selection from the store (getState) so the effect does
  // not re-run on every chip toggle (which would loop through prune → patch).
  useEffect(() => {
    if (!activeTicketId) return;
    const workspacesStore = useTicketWorkspacesStore.getState();
    const ticket = workspacesStore.tickets.find((t) => t.id === activeTicketId);
    const selected = ticket?.composer.labels ?? [];
    if (!status?.supportsLabels) {
      if (selected.length > 0) {
        workspacesStore.patchComposer(activeTicketId, { labels: [] });
      }
      return;
    }
    const freeform = Boolean(status.supportsFreeformLabels);
    if (labelsQuery.error) {
      const cleared = selectionAfterLabelsFailure(selected, { keepOnFailure: freeform });
      if (cleared.length !== selected.length) {
        workspacesStore.patchComposer(activeTicketId, { labels: cleared });
      }
      return;
    }
    if (!labelsQuery.data) return;
    const pruned = pruneSelectedLabels(selected, labelsQuery.data.labels, {
      keepUnknown: freeform,
    });
    if (pruned.length !== selected.length || pruned.some((id, i) => id !== selected[i])) {
      workspacesStore.patchComposer(activeTicketId, { labels: pruned });
    }
  }, [
    activeTicketId,
    labelsQuery.data,
    labelsQuery.error,
    status?.supportsLabels,
    status?.supportsFreeformLabels,
  ]);

  const retryLabels = useCallback(() => {
    if (!projectDir || !activeProjectKey) return;
    invalidateLabels(queryClient, projectDir, activeProjectKey);
  }, [projectDir, activeProjectKey]);

  return {
    issueTypes,
    labels,
    labelsTruncated,
    labelsError,
    issueTypesQuery,
    labelsQuery,
    retryLabels,
  };
}

/** Combined app data used by the `App` component. */
export function useAppData() {
  return { ...useAppChrome(), ...useTicketMetadata() };
}
