import { describe, expect, test } from "bun:test";

import { taskTabLabel } from "./helpers";

describe("taskTabLabel", () => {
  test("calls the text a prompt for prompt automations", () => {
    expect(taskTabLabel("scheduled")).toBe("Prompt");
    expect(taskTabLabel("manual")).toBe("Prompt");
  });

  test("keeps the task description label for other origins", () => {
    expect(taskTabLabel("task")).toBe("Task description");
    expect(taskTabLabel("auto_merge")).toBe("Task description");
  });
});
