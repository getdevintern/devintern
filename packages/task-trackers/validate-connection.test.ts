import { describe, expect, test } from "bun:test";

import {
  MAX_EDIT_ATTEMPTS,
  MAX_PROMPT_ATTEMPTS,
  MAX_RETRY_ATTEMPTS,
  PromptAttemptsExceededError,
  validateConnection,
} from "./src/init/wizard-core.ts";
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

  test("stops after repeated unusable menu answers instead of looping", async () => {
    const questions: string[] = [];
    let probes = 0;
    const promise = validateConnection(
      "github",
      { GITHUB_TOKEN: "x", GITHUB_REPO: "acme/app" },
      steps,
      {
        prompt: async (question) => {
          questions.push(question);
          return "maybe";
        },
        probe: async () => {
          probes += 1;
          throw new Error("401");
        },
        log: () => {},
      },
      "~/.devintern/.env",
    );

    await expect(promise).rejects.toBeInstanceOf(PromptAttemptsExceededError);
    expect(questions).toHaveLength(MAX_PROMPT_ATTEMPTS);
    expect(probes).toBe(MAX_PROMPT_ATTEMPTS);
  });

  test("Enter retries with the current values but still spends the budget", async () => {
    const logs: string[] = [];
    let probes = 0;
    const promise = validateConnection(
      "github",
      { GITHUB_TOKEN: "x", GITHUB_REPO: "acme/app" },
      steps,
      {
        prompt: async () => "",
        probe: async () => {
          probes += 1;
          throw new Error("401");
        },
        log: (message) => logs.push(message),
      },
      "~/.devintern/.env",
    );

    await expect(promise).rejects.toBeInstanceOf(PromptAttemptsExceededError);
    expect(probes).toBe(MAX_PROMPT_ATTEMPTS);
    // The repeated prompt is explained before the loop stops.
    expect(logs).toContain("   Press Enter to retry, or enter r, e, or s.");
  });

  test("stops after repeated deliberate retries instead of looping", async () => {
    let probes = 0;
    const promise = validateConnection(
      "github",
      { GITHUB_TOKEN: "x", GITHUB_REPO: "acme/app" },
      steps,
      {
        // "r" is a valid answer, so this is the path that used to loop forever.
        prompt: async () => "r",
        probe: async () => {
          probes += 1;
          throw new Error("401");
        },
        log: () => {},
      },
      "~/.devintern/.env",
    );

    await expect(promise).rejects.toBeInstanceOf(PromptAttemptsExceededError);
    expect(probes).toBe(MAX_RETRY_ATTEMPTS);
  });

  test("an edit answer past the edit budget is rejected, not retried forever", async () => {
    const questions: string[] = [];
    let probes = 0;
    const promise = validateConnection(
      "github",
      { GITHUB_TOKEN: "x", GITHUB_REPO: "acme/app" },
      // No steps: choosing "edit" only consumes budget, so the prompt script
      // is just the "what next" answer.
      [],
      {
        prompt: async (question) => {
          questions.push(question);
          return "e";
        },
        probe: async () => {
          probes += 1;
          throw new Error("401");
        },
        log: () => {},
      },
      "~/.devintern/.env",
    );

    await expect(promise).rejects.toBeInstanceOf(PromptAttemptsExceededError);
    // MAX_EDIT_ATTEMPTS offered edits, then MAX_PROMPT_ATTEMPTS unoffered "e"
    // answers before the loop stopped.
    expect(questions).toHaveLength(MAX_EDIT_ATTEMPTS + MAX_PROMPT_ATTEMPTS);
    expect(probes).toBe(MAX_EDIT_ATTEMPTS + MAX_PROMPT_ATTEMPTS);
  });
});
