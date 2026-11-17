import { afterEach, describe, expect, test } from "bun:test";

import { runContext } from "../src/lib/cli/context";
import { RUN_ORIGIN_ENV } from "../src/lib/observability/analytics";
import { reportProcessingFailure } from "../src/lib/task/processing-failure";
import type { TaskTrackerClient } from "../src/lib/trackers/client";

describe("reportProcessingFailure", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    runContext.activeTaskContext = null;
  });

  test("does not attempt markdown retry-state recording for injected local runs", async () => {
    process.env[RUN_ORIGIN_ENV] = "local";
    delete process.env.MARKDOWN_TASKS_DIR;
    runContext.options = { skipComments: false } as typeof runContext.options;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    let comments = 0;
    let taskFetches = 0;
    const tracker = {
      getTask: async () => {
        taskFetches++;
        throw new Error(
          'Cannot resolve markdown task "local-interrupted" without MARKDOWN_TASKS_DIR or a file path',
        );
      },
      postComment: async () => {
        comments++;
      },
      transitionStatus: async () => {},
      extractDescriptionText: () => "",
    } as unknown as TaskTrackerClient;

    runContext.activeTaskContext = {
      taskKey: "local-interrupted",
      tracker,
      projectKey: "",
      movedToInProgress: true,
    };

    try {
      await expect(reportProcessingFailure("local-interrupted", "interrupted")).resolves.toBe(true);
    } finally {
      console.warn = originalWarn;
    }

    // The durable injected row is the record: no tracker comment, no task
    // lookup, and none of the markdown-resolution warnings the old path logged.
    expect(comments).toBe(0);
    expect(taskFetches).toBe(0);
    expect(warnings.some((warning) => warning.includes("Cannot resolve markdown task"))).toBe(
      false,
    );
  });
});
