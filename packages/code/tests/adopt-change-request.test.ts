import { afterEach, describe, expect, test } from "bun:test";

import { adoptAgentCreatedChangeRequest } from "../src/lib/agent/adopt-change-request";
import type { ChangeRequestIdentity } from "../src/lib/code-host/provider";

const identity = (): ChangeRequestIdentity => ({
  provider: "github",
  instanceUrl: "https://github.com",
  projectPath: "owner/repo",
  number: 7,
  webUrl: "https://github.com/owner/repo/pull/7",
});

afterEach(() => {
  delete process.env.PR_LABELS;
});

describe("adoptAgentCreatedChangeRequest", () => {
  test("labels and registers an existing PR", async () => {
    const lookups: string[] = [];
    const labeled: Array<{ identity: ChangeRequestIdentity; labels: string[] }> = [];
    const recorded: Array<{ identity: ChangeRequestIdentity; branch: string }> = [];

    const adopted = await adoptAgentCreatedChangeRequest({
      taskKey: "local-x",
      branch: "feature/local-x",
      labels: ["devintern-authored"],
      manager: {
        findOpenChangeRequest: async (branch) => {
          lookups.push(branch);
          return identity();
        },
        applyLabelsToChangeRequest: async (change, labels) => {
          labeled.push({ identity: change, labels });
        },
      },
      record: (change, branch) => recorded.push({ identity: change, branch }),
    });

    expect(adopted?.number).toBe(7);
    expect(lookups).toEqual(["feature/local-x"]);
    expect(labeled).toHaveLength(1);
    expect(labeled[0]?.labels).toEqual(["devintern-authored"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.branch).toBe("feature/local-x");
  });

  test("does nothing when no PR exists for the branch", async () => {
    let labeled = 0;
    let recorded = 0;
    const adopted = await adoptAgentCreatedChangeRequest({
      taskKey: "local-x",
      branch: "feature/local-x",
      manager: {
        findOpenChangeRequest: async () => undefined,
        applyLabelsToChangeRequest: async () => {
          labeled++;
        },
      },
      record: () => {
        recorded++;
      },
    });

    expect(adopted).toBeUndefined();
    expect(labeled).toBe(0);
    expect(recorded).toBe(0);
  });

  test("skips base branches without querying the provider", async () => {
    let lookups = 0;
    const adopted = await adoptAgentCreatedChangeRequest({
      taskKey: "local-x",
      branch: "main",
      manager: {
        findOpenChangeRequest: async () => {
          lookups++;
          return identity();
        },
        applyLabelsToChangeRequest: async () => {},
      },
      record: () => {},
    });

    expect(adopted).toBeUndefined();
    expect(lookups).toBe(0);
  });

  test("uses PR_LABELS when labels are not passed explicitly", async () => {
    process.env.PR_LABELS = "devintern-authored, backend";
    const applied: string[][] = [];

    await adoptAgentCreatedChangeRequest({
      taskKey: "local-x",
      branch: "feature/local-x",
      manager: {
        findOpenChangeRequest: async () => identity(),
        applyLabelsToChangeRequest: async (_change, labels) => {
          applied.push(labels);
        },
      },
      record: () => {},
    });

    expect(applied).toEqual([["devintern-authored", "backend"]]);
  });

  test("swallows provider failures on the failure path", async () => {
    const adopted = await adoptAgentCreatedChangeRequest({
      taskKey: "local-x",
      branch: "feature/local-x",
      manager: {
        findOpenChangeRequest: async () => {
          throw new Error("network down");
        },
        applyLabelsToChangeRequest: async () => {},
      },
      record: () => {},
    });

    expect(adopted).toBeUndefined();
  });
});
