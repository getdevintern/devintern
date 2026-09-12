/**
 * Task tracker error hierarchy.
 *
 * Split from `task-tracker.ts` so each module stays within the
 * `max-classes-per-file` budget.
 */

export class TaskTrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTrackerError";
  }
}

export class AuthenticationError extends TaskTrackerError {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class TransitionError extends TaskTrackerError {
  constructor(statusName: string, taskKey: string) {
    super(`Failed to transition ${taskKey} to "${statusName}"`);
    this.name = "TransitionError";
  }
}
