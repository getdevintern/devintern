import { describe, expect, test } from "bun:test";
import { toEngineCreateTaskOptions } from "./create-task-options.ts";
import type { CreateTaskRequest } from "../shared/ipc-contract.ts";

const baseRequest: CreateTaskRequest = {
  draft: { summary: "S", description: "D" },
  issueType: "Task",
  projectKey: "ENG",
  epicKey: "ENG-1",
  labels: ["bug"],
};

describe("toEngineCreateTaskOptions", () => {
  test("maps public CreateTaskRequest fields only", () => {
    expect(toEngineCreateTaskOptions(baseRequest)).toEqual({
      issueType: "Task",
      projectKey: "ENG",
      epicKey: "ENG-1",
      labels: ["bug"],
      attachments: undefined,
    });
  });

  test("never forwards labelsPrevalidated from a sneaky renderer payload", () => {
    const sneaky = {
      ...baseRequest,
      labelsPrevalidated: true,
    } as CreateTaskRequest & { labelsPrevalidated: boolean };

    const options = toEngineCreateTaskOptions(sneaky);
    expect("labelsPrevalidated" in options).toBe(false);
    expect(
      (options as CreateTaskRequest & { labelsPrevalidated?: boolean }).labelsPrevalidated,
    ).toBeUndefined();
  });
});
