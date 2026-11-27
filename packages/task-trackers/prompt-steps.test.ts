import { describe, expect, test } from "bun:test";

import {
  MAX_PROMPT_ATTEMPTS,
  PromptAttemptsExceededError,
  promptForTracker,
  promptSteps,
} from "./src/init/wizard-core.ts";

describe("promptSteps", () => {
  test("keeps GitHub capitalised in the token link line", async () => {
    const logs: string[] = [];
    const values: Record<string, string> = {};
    await promptSteps(
      [
        {
          key: "GITHUB_TOKEN",
          label: "GitHub personal access token",
          secret: true,
          link: "https://github.com/settings/tokens",
        },
      ],
      async () => "ghp_test",
      (message) => logs.push(message),
      values,
      async () => "ghp_test",
    );
    expect(logs.join("\n")).toContain("Create your GitHub personal access token at:");
  });

  test("shows an inline default in brackets instead of the example hint", async () => {
    const questions: string[] = [];
    const values: Record<string, string> = {};
    await promptSteps(
      [
        {
          key: "GITHUB_REPO",
          label: "Repository",
          example: "owner/repo",
          defaultValue: "acme/app",
          defaultInBrackets: true,
        },
      ],
      async (question) => {
        questions.push(question);
        return "";
      },
      () => {},
      values,
    );
    expect(questions).toEqual(["Repository [acme/app]: "]);
    expect(values).toEqual({ GITHUB_REPO: "acme/app" });
  });

  test("still re-asks a required step a couple of times", async () => {
    const values: Record<string, string> = {};
    const answers = ["", "", "acme/app"];
    await promptSteps(
      [{ key: "GITHUB_REPO", label: "Repository" }],
      async () => answers.shift() ?? "",
      () => {},
      values,
    );
    expect(values).toEqual({ GITHUB_REPO: "acme/app" });
  });

  test("stops a required step that never gets an answer", async () => {
    const values: Record<string, string> = {};
    const questions: string[] = [];
    const promise = promptSteps(
      [{ key: "GITHUB_REPO", label: "Repository" }],
      async (question) => {
        questions.push(question);
        return "";
      },
      () => {},
      values,
    );
    await expect(promise).rejects.toBeInstanceOf(PromptAttemptsExceededError);
    await expect(promise).rejects.toThrow("GITHUB_REPO is required");
    expect(questions).toHaveLength(MAX_PROMPT_ATTEMPTS);
    expect(values).toEqual({});
  });
});

describe("promptForTracker", () => {
  test("stops after repeated invalid menu choices", async () => {
    const promise = promptForTracker(
      async () => "",
      () => {},
      [{ id: "jira", displayName: "Jira" }],
    );
    await expect(promise).rejects.toThrow("No valid tracker choice");
  });
});
