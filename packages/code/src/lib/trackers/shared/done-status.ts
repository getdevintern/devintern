/**
 * Status names that mean "finished" for trackers without a status category
 * (Trello list names, markdown `status:` frontmatter). Canceled counts as
 * finished, like Linear's `canceled` state type: a canceled blocker no longer
 * blocks anything.
 */
const DONE_STATUS_NAMES = new Set([
  "done",
  "complete",
  "completed",
  "closed",
  "canceled",
  "cancelled",
]);

/** Whether a free-form status name means the ticket is finished. */
export function isDoneStatusName(status: string | undefined): boolean {
  return status !== undefined && DONE_STATUS_NAMES.has(status.trim().toLowerCase());
}
