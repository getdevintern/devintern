import { TaskTrackerError } from "../../../types/task-tracker";

interface IssueStatusOperations {
  scope: "repository" | "project";
  getLabels(limit?: number): Promise<{ labels: Array<{ name: string }>; truncated: boolean }>;
  getIssue(): Promise<{ labels: string[]; closed: boolean }>;
  close(): Promise<void>;
  reopen(): Promise<void>;
  addLabel(name: string): Promise<void>;
  removeLabel(name: string): Promise<void>;
}

const CLOSE_STATUS_NAMES = new Set(["closed", "done", "complete", "completed"]);

/** Shared label policy; API state values and label representations stay in the clients. */
export async function transitionIssueStatus(
  statusName: string,
  statusLabels: string[],
  operations: IssueStatusOperations,
): Promise<void> {
  if (CLOSE_STATUS_NAMES.has(statusName.toLowerCase())) {
    await operations.close();
    return;
  }

  // A truncated picker catalog is insufficient to reject a configured status.
  let { labels, truncated } = await operations.getLabels();
  let target = labels.find((label) => label.name.toLowerCase() === statusName.toLowerCase());
  if (!target && truncated) {
    ({ labels } = await operations.getLabels(Number.POSITIVE_INFINITY));
    target = labels.find((label) => label.name.toLowerCase() === statusName.toLowerCase());
  }
  if (!target) {
    throw new TaskTrackerError(
      `Label "${statusName}" not found in the ${operations.scope}. Available labels: ${labels.map((label) => label.name).join(", ")}. ` +
        "Create the label or update the status names in .devintern-code/settings.json.",
    );
  }

  const issue = await operations.getIssue();
  const otherStatuses = issue.labels.filter(
    (name) =>
      name.toLowerCase() !== target.name.toLowerCase() &&
      statusLabels.some((status) => status.toLowerCase() === name.toLowerCase()),
  );
  await operations.addLabel(target.name);
  for (const label of otherStatuses) await operations.removeLabel(label);
  if (issue.closed) await operations.reopen();
}
