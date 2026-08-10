import { describe, expect, test } from "bun:test";
import {
  formatGitHubRepoLabel,
  githubHttpsRemoteUrl,
  parseGitHubRepoInput,
} from "./github-repo.ts";

describe("parseGitHubRepoInput", () => {
  test("accepts owner/repo", () => {
    expect(parseGitHubRepoInput("Acme/My-App")).toEqual({
      owner: "Acme",
      repo: "My-App",
      slug: "acme/my-app",
    });
  });

  test("accepts HTTPS URLs with optional .git and path suffixes", () => {
    expect(parseGitHubRepoInput("https://github.com/acme/web.git")?.slug).toBe("acme/web");
    expect(parseGitHubRepoInput("https://github.com/acme/web/tree/main")?.slug).toBe("acme/web");
    expect(parseGitHubRepoInput("github.com/acme/web")?.slug).toBe("acme/web");
  });

  test("accepts SSH URLs", () => {
    expect(parseGitHubRepoInput("git@github.com:acme/web.git")?.slug).toBe("acme/web");
  });

  test("rejects non-GitHub and malformed input", () => {
    expect(parseGitHubRepoInput("")).toBeNull();
    expect(parseGitHubRepoInput("not a repo")).toBeNull();
    expect(parseGitHubRepoInput("https://gitlab.com/acme/web")).toBeNull();
    expect(parseGitHubRepoInput("acme")).toBeNull();
  });
});

describe("githubHttpsRemoteUrl", () => {
  test("builds clone URL", () => {
    expect(githubHttpsRemoteUrl("acme", "web")).toBe("https://github.com/acme/web.git");
  });
});

describe("formatGitHubRepoLabel", () => {
  test("preserves typed casing", () => {
    expect(formatGitHubRepoLabel({ owner: "Acme", repo: "Web" })).toBe("Acme/Web");
  });
});
