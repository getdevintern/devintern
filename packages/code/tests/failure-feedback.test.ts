import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";

import { MAX_FAILURE_REASON_LENGTH, reportTaskFailure } from "../src/lib/task/failure-feedback";
import {
  formatRetryPickupMarkdown,
  isProcessingFailureCommentText,
} from "../src/lib/trackers/shared/markdown-comment-formatter";
import { RetryStateStore, hashDescription } from "../src/lib/state/retry-state";
import type { TaskTrackerClient } from "../src/lib/trackers/client";
import type { Task, TaskTrackerCommentContent } from "../src/types/task-tracker";

describe("reportTaskFailure", () => {
  let tempDir: string;
  let store: RetryStateStore;
  let posted: string[] = [];
  let transitions: string[] = [];
  let taskFetches: number;

  const task: Task = {
    key: "PROJ-1",
    summary: "Fix the thing",
    issueType: "Task",
    status: "In Progress",
    reporter: "Alice",
    created: "",
    updated: "",
    labels: [],
    components: [],
    fixVersions: [],
    raw: null,
  };

  function fakeTracker(): TaskTrackerClient {
    return {
      getTask: async () => {
        taskFetches++;
        return task;
      },
      postComment: async (_key: string, content: TaskTrackerCommentContent) => {
        posted.push(content.body);
      },
      transitionStatus: async (_key: string, status: string) => {
        transitions.push(status);
      },
      extractDescriptionText: (t: Task): string => `description of ${t.summary}`,
    } as unknown as TaskTrackerClient;
  }

  function deps(overrides: Partial<Parameters<typeof reportTaskFailure>[0]> = {}) {
    return {
      taskKey: "PROJ-1",
      reason: "Agent exited with code 1",
      tracker: fakeTracker(),
      trackerType: "jira",
      projectKey: "PROJ",
      movedToInProgress: true,
      getTodoStatus: () => "To Do",
      recordAttempt: (key: string, type: string, description: string) =>
        store.recordIncompleteAttempt(key, type, description),
      log: () => {},
      warn: () => {},
      ...overrides,
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "devintern-failure-feedback-"));
    store = new RetryStateStore(path.join(tempDir, "queue.db"));
    posted = [];
    transitions = [];
    taskFetches = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("posts a processing-failure comment and records retry state", async () => {
    await reportTaskFailure(deps());

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Automated implementation did not complete");
    expect(posted[0]).toContain("Agent exited with code 1");

    const state = store.getRetryState("PROJ-1");
    expect(state).not.toBeNull();
    expect(state!.tracker).toBe("jira");
    expect(state!.descriptionHash).toBe(hashDescription("description of Fix the thing"));
  });

  test("does not record retry state when the comment fails to post", async () => {
    const tracker = {
      ...fakeTracker(),
      postComment: async () => {
        throw new Error("tracker down");
      },
    } as unknown as TaskTrackerClient;

    await reportTaskFailure(deps({ tracker }));

    expect(store.getRetryState("PROJ-1")).toBeNull();
  });

  test("moves an in-progress ticket back to To Do", async () => {
    await reportTaskFailure(deps());
    expect(transitions).toEqual(["To Do"]);
  });

  test("skips the status transition when the run never reached In Progress", async () => {
    await reportTaskFailure(deps({ movedToInProgress: false }));
    expect(transitions).toEqual([]);
  });

  test("skips the status transition when no todo status is configured", async () => {
    await reportTaskFailure(deps({ getTodoStatus: () => null }));
    expect(transitions).toEqual([]);
  });

  test("comment still posts when the description fetch for retry state fails", async () => {
    const tracker = {
      ...fakeTracker(),
      getTask: async () => {
        throw new Error("fetch failed");
      },
    } as unknown as TaskTrackerClient;

    await reportTaskFailure(deps({ tracker }));

    expect(posted).toHaveLength(1);
    expect(store.getRetryState("PROJ-1")).toBeNull();
  });

  test("never throws even if every tracker call rejects", async () => {
    const tracker = {
      getTask: async () => {
        throw new Error("fetch failed");
      },
      postComment: async () => {
        throw new Error("post failed");
      },
      transitionStatus: async () => {
        throw new Error("transition failed");
      },
      extractDescriptionText: (): string => "",
    } as unknown as TaskTrackerClient;

    await expect(reportTaskFailure(deps({ tracker }))).resolves.toBe(false);
  });

  test("reports true only when the failure comment was delivered", async () => {
    expect(await reportTaskFailure(deps())).toBe(true);

    const tracker = {
      ...fakeTracker(),
      postComment: async () => {
        throw new Error("tracker down");
      },
    } as unknown as TaskTrackerClient;

    expect(await reportTaskFailure(deps({ tracker }))).toBe(false);
  });
  test("redacts credentials and the home directory from the posted reason", async () => {
    const home = homedir();
    const ghToken = `ghp_${"A".repeat(36)}`;
    const envToken = "s3cr3tEnvTokenValue123";
    const reason = [
      `git push failed: remote rejected token ${ghToken}`,
      `hook env: GITHUB_TOKEN=${envToken}`,
      "fatal: unable to access 'https://alice:hunter2pass@git.example.com/org/repo.git/'",
      `while running ${home}/projects/repo/.git/hooks/pre-push`,
    ].join("\n");

    await reportTaskFailure(deps({ reason }));

    expect(posted).toHaveLength(1);
    const body = posted[0];
    expect(body).not.toContain(ghToken);
    expect(body).not.toContain(envToken);
    expect(body).not.toContain("hunter2pass");
    expect(body).not.toContain("alice:");
    expect(body).not.toContain(`${home}/`);
    expect(body).toContain("~/projects/repo/.git/hooks/pre-push");
    expect(body).toContain("git push failed");
    expect(isProcessingFailureCommentText(body)).toBe(true);
    expect(body).toContain(formatRetryPickupMarkdown());
  });

  test("truncates an oversized reason", async () => {
    const reason = "x".repeat(MAX_FAILURE_REASON_LENGTH * 5);

    await reportTaskFailure(deps({ reason }));

    const body = posted[0];
    expect(body).toContain(`${"x".repeat(MAX_FAILURE_REASON_LENGTH)}…`);
    expect(body).not.toContain("x".repeat(MAX_FAILURE_REASON_LENGTH + 1));
    expect(isProcessingFailureCommentText(body)).toBe(true);
    expect(body).toContain(formatRetryPickupMarkdown());
  });
});
