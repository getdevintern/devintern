import { describe, expect, test } from "bun:test";

import {
  GITHUB_CLASSIC_TOKEN_URL,
  GITHUB_FINE_GRAINED_PERMISSIONS,
  GITHUB_FINE_GRAINED_TOKEN_URL,
  describeGitHubTokenProblem,
  githubTokenLinkDetails,
} from "./src/init/github-token-guidance.ts";
import { describeProbeFailure, promptSteps, validateConnection } from "./src/init/wizard-core.ts";
import type { EnvPromptStep } from "./src/init/wizard-core.ts";

describe("describeGitHubTokenProblem", () => {
  test("a 401 says the token is invalid or expired and how to create a new one", () => {
    const problem = describeGitHubTokenProblem(
      'GitHub API error (401) checking acme/app: {"message":"Bad credentials"}',
    );
    expect(problem?.kind).toBe("invalid");
    expect(problem?.text).toContain("invalid, expired, or revoked");
    expect(problem?.hint).toContain(GITHUB_FINE_GRAINED_TOKEN_URL);
    expect(problem?.hint).toContain(GITHUB_CLASSIC_TOKEN_URL);
    expect(problem?.hint).toContain(GITHUB_FINE_GRAINED_PERMISSIONS);
  });

  test("a repository the token cannot see names the repository and the grant", () => {
    const problem = describeGitHubTokenProblem(
      "GitHub token cannot access acme/app (HTTP 404): check GITHUB_REPO and that the token is granted this repository",
    );
    expect(problem).toMatchObject({ kind: "no-access", repo: "acme/app" });
    expect(problem?.text).toBe(
      "GITHUB_TOKEN has no access to acme/app: the repository does not exist or the token is not granted it",
    );
    expect(problem?.hint).toContain("Check that GITHUB_REPO is right");
    expect(problem?.hint).toContain("add it under Repository access");
  });

  test("the doctor's repository probe 404 reads as no access", () => {
    expect(
      describeGitHubTokenProblem(
        "GitHub API 404 for acme/app (missing or not visible to GITHUB_TOKEN)",
      ),
    ).toMatchObject({ kind: "no-access", repo: "acme/app" });
  });

  test("rate limits and network errors keep the raw message", () => {
    expect(
      describeGitHubTokenProblem("GitHub API error (403): API rate limit exceeded (rate limit)"),
    ).toBeUndefined();
    expect(describeGitHubTokenProblem("fetch failed: ECONNRESET")).toBeUndefined();
  });

  test("link details offer the fine-grained permissions and the classic link", () => {
    const [fineGrained, classic] = githubTokenLinkDetails("acme/app");
    expect(fineGrained).toContain("Repository access → acme/app");
    expect(fineGrained).toContain(GITHUB_FINE_GRAINED_PERMISSIONS);
    expect(classic).toContain(GITHUB_CLASSIC_TOKEN_URL);
  });
});

describe("describeProbeFailure", () => {
  test("GitHub 401 marks the secrets rejected and carries the fix", () => {
    const failure = describeProbeFailure("github", "GitHub API error (401): Bad credentials");
    expect(failure.rejectedSecrets).toBe(true);
    expect(failure.hint).toContain(GITHUB_FINE_GRAINED_TOKEN_URL);
  });

  test("GitHub no-access keeps the token (it may only need a grant)", () => {
    const failure = describeProbeFailure(
      "github",
      "GitHub token cannot access acme/app (HTTP 404): check GITHUB_REPO",
    );
    expect(failure.rejectedSecrets).toBe(false);
    expect(failure.text).toContain("no access to acme/app");
  });

  test("other trackers' 401 also rejects the secrets", () => {
    expect(describeProbeFailure("linear", "Linear API error (401)").rejectedSecrets).toBe(true);
    expect(describeProbeFailure("linear", "fetch failed").rejectedSecrets).toBe(false);
  });
});

describe("GitHub token in the wizard", () => {
  const steps: EnvPromptStep[] = [
    { key: "GITHUB_TOKEN", label: "Token", secret: true },
    { key: "GITHUB_REPO", label: "Repository", defaultValue: "acme/app" },
  ];

  test("a rejected token prints the clear message and is not offered as the Enter default", async () => {
    const logs: string[] = [];
    const questions: string[] = [];
    const answers = ["e", "ghp_new", ""];
    const values = { GITHUB_TOKEN: "garbage", GITHUB_REPO: "acme/app" };
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
          if (calls === 1) throw new Error("GitHub API error (401) checking acme/app");
        },
        log: (message) => logs.push(message),
      },
      "~/.devintern/.env",
    );
    const text = logs.join("\n");
    expect(text).toContain("invalid, expired, or revoked");
    expect(text).toContain(GITHUB_FINE_GRAINED_TOKEN_URL);
    expect(text).not.toContain("GitHub API error (401)");
    expect(questions).toContain("Token: ");
    expect(questions.some((q) => q.startsWith("Token (Enter for default)"))).toBe(false);
    expect(values.GITHUB_TOKEN).toBe("ghp_new");
  });

  test("a token without repository access stays the Enter default", async () => {
    const questions: string[] = [];
    const answers = ["e", "", "acme/right"];
    const values = { GITHUB_TOKEN: "ghp_ok", GITHUB_REPO: "acme/wrong" };
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
          if (calls === 1) throw new Error("GitHub token cannot access acme/wrong (HTTP 404)");
        },
        log: () => {},
      },
      "~/.devintern/.env",
    );
    expect(questions).toContain("Token (Enter for default): ");
    expect(values).toEqual({ GITHUB_TOKEN: "ghp_ok", GITHUB_REPO: "acme/right" });
  });

  test("the token prompt prints the link details under the link", async () => {
    const logs: string[] = [];
    await promptSteps(
      [
        {
          key: "GITHUB_TOKEN",
          label: "GitHub personal access token",
          link: GITHUB_FINE_GRAINED_TOKEN_URL,
          linkDetails: () => githubTokenLinkDetails(),
        },
      ],
      async () => "ghp_test",
      (message) => logs.push(message),
      {},
    );
    const text = logs.join("\n");
    expect(text).toContain(GITHUB_FINE_GRAINED_TOKEN_URL);
    expect(text).toContain(GITHUB_FINE_GRAINED_PERMISSIONS);
    expect(text).toContain(GITHUB_CLASSIC_TOKEN_URL);
  });
});
