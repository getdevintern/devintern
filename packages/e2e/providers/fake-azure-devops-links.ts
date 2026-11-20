/**
 * Work-item links and process states for the Azure DevOps fake: the payloads
 * the product's predecessor read (`AzureDevOpsClient.listPredecessors` and
 * `AzureDevOpsClient.stateCategory` in `packages/task-trackers`) parses.
 */

/** Configured workflow state names (structurally `FakeAzureDevOpsStatuses`). */
interface WorkflowStates {
  todo: string;
  inProgress: string;
  pr: string;
  done: string;
}

/**
 * One stored work-item link, in the shape the real service returns under
 * `relations`: `rel` is the link type reference name and `url` is the REST URL
 * of the linked work item (`…/_apis/wit/workItems/<id>`).
 */
export interface FakeAzureDevOpsRelation {
  rel: string;
  url: string;
  attributes: { isLocked: boolean; name: string };
}

/** Link types the fake knows by name, keyed by reference name. */
export const RELATION_NAMES: Record<string, string> = {
  "System.LinkTypes.Dependency-Reverse": "Predecessor",
  "System.LinkTypes.Dependency-Forward": "Successor",
  "System.LinkTypes.Hierarchy-Reverse": "Parent",
  "System.LinkTypes.Hierarchy-Forward": "Child",
  "System.LinkTypes.Related": "Related",
};

/** One blocker-related read the fake received (see `AzureDevOpsClient.listPredecessors`). */
export interface FakeAzureDevOpsBlockerRequest {
  /**
   * `relations`: `GET …/workitems/{id}?$expand=relations`; `batch`: the
   * `GET …/workitems?ids=…&errorPolicy=omit` predecessor-state read;
   * `states`: the `GET {project}/_apis/wit/workitemtypes/{type}/states`
   * state-category read.
   */
  kind: "relations" | "batch" | "states";
  /** Requested work-item ids (one for `relations`, none for `states`). */
  ids: number[];
  /** HTTP status the fake answered with. */
  status: number;
  /** Fake-side receive time (epoch ms). */
  at: number;
}

/**
 * Project of a `GET {project}/_apis/wit/workitemtypes/{type}/states` request,
 * or `undefined` for any other route.
 */
export function workItemTypeStatesProject(method: string, scopedPath: string): string | undefined {
  if (method !== "GET") return undefined;
  return scopedPath.match(/^\/([^/]+)\/_apis\/wit\/workitemtypes\/[^/]+\/states$/i)?.[1];
}

/**
 * States of a work-item type with their process category, as the states
 * endpoint returns them. The fake serves one Agile-like list for every type,
 * built from its configured state names.
 */
export function workItemTypeStates(statuses: WorkflowStates): {
  count: number;
  value: Array<{ name: string; category: string; color: string }>;
} {
  const states = new Map<string, string>();
  const add = (name: string, category: string) => {
    if (!states.has(name)) states.set(name, category);
  };
  add(statuses.todo, "Proposed");
  add(statuses.inProgress, "InProgress");
  add(statuses.pr, "Resolved");
  add(statuses.done, "Completed");
  add("Removed", "Removed");
  const value = [...states].map(([name, category]) => ({ name, category, color: "b2b2b2" }));
  return { count: value.length, value };
}
