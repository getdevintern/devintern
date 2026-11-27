import { describe, expect, test } from "bun:test";

import { promptSteps } from "./src/init/wizard-core.ts";

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
});
