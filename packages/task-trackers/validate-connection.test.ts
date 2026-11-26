import { describe, expect, test } from "bun:test";

import { validateConnection } from "./src/init/wizard-core.ts";
import type { EnvPromptStep } from "./src/init/wizard-core.ts";

describe("validateConnection", () => {
  const steps: EnvPromptStep[] = [
    { key: "GITHUB_TOKEN", label: "Token", secret: true },
    { key: "GITHUB_REPO", label: "Repository", defaultValue: "acme/app" },
  ];

  test("edit values keeps what was entered as the Enter default", async () => {
    const answers = ["e", "ghp_new", ""];
    const questions: string[] = [];
    const values = { GITHUB_TOKEN: "ghp_old", GITHUB_REPO: "acme/other" };
    let calls = 0;
    await validateConnection(
      "github",
      values,
      steps,
      {
        prompt: async (question) => {
          questions.push(question);
          return answers.shift() ?? "";
        },
        probe: async () => {
          calls += 1;
          if (calls === 1) throw new Error("401");
        },
        log: () => {},
      },
      "~/.devintern/.env",
    );
    // The repo typed earlier (not the step's own default) survives an Enter.
    expect(values).toEqual({ GITHUB_TOKEN: "ghp_new", GITHUB_REPO: "acme/other" });
    expect(questions).toContain("Repository (Enter for default): ");
  });

  test("skip names the given env file", async () => {
    const logs: string[] = [];
    await validateConnection(
      "github",
      { GITHUB_TOKEN: "x", GITHUB_REPO: "acme/app" },
      steps,
      {
        prompt: async () => "s",
        probe: async () => {
          throw new Error("401");
        },
        log: (message) => logs.push(message),
      },
      "/home/me/.devintern/.env",
    );
    expect(logs.join("\n")).toContain("verify them in /home/me/.devintern/.env");
  });
});
