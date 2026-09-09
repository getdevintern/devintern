import { describe, expect, test } from "bun:test";
import {
  normalizeCodeHostUrl,
  parseChangeRequestUrl,
  parseGitLabHostAliases,
  parseGitRemoteUrl,
} from "../src/lib/code-host";

describe("parseGitRemoteUrl", () => {
  test.each([
    ["https://github.com/acme/widgets.git", "github", "acme/widgets"],
    ["git@github.com:acme/widgets.git", "github", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets", "github", "acme/widgets"],
    ["https://gitlab.com/acme/platform/widgets.git", "gitlab", "acme/platform/widgets"],
    ["git@gitlab.com:acme/platform/widgets.git", "gitlab", "acme/platform/widgets"],
  ])("parses %s", (remote, provider, projectPath) => {
    expect(parseGitRemoteUrl(remote)).toMatchObject({ provider, projectPath });
  });

  test("parses Bitbucket without changing its legacy repository contract", () => {
    expect(parseGitRemoteUrl("git@bitbucket.org:acme/widgets.git")).toEqual({
      provider: "bitbucket",
      instanceUrl: "https://bitbucket.org",
      projectPath: "acme/widgets",
      repository: "widgets",
      workspace: "acme",
    });
  });

  test("matches a self-managed instance with a relative path and custom port", () => {
    expect(
      parseGitRemoteUrl("https://git.example.test:8443/gitlab/acme/platform/widgets.git", {
        gitlabBaseUrl: "https://git.example.test:8443/gitlab/",
      }),
    ).toEqual({
      provider: "gitlab",
      instanceUrl: "https://git.example.test:8443/gitlab",
      projectPath: "acme/platform/widgets",
      repository: "acme/platform/widgets",
    });
  });

  test("maps SSH aliases to the configured GitLab instance", () => {
    expect(
      parseGitRemoteUrl("git@corp-git:acme/widgets.git", {
        gitlabBaseUrl: "https://git.example.test/gitlab",
        gitlabHostAliases: ["corp-git"],
      }),
    ).toMatchObject({
      provider: "gitlab",
      instanceUrl: "https://git.example.test/gitlab",
      projectPath: "acme/widgets",
    });
  });

  test("does not apply a self-managed profile to gitlab.com", () => {
    expect(
      parseGitRemoteUrl("git@gitlab.com:acme/widgets.git", {
        gitlabBaseUrl: "https://git.example.test/gitlab",
      }),
    ).toMatchObject({ instanceUrl: "https://gitlab.com", projectPath: "acme/widgets" });
    expect(
      parseChangeRequestUrl("https://gitlab.com/acme/widgets/-/merge_requests/4", {
        gitlabBaseUrl: "https://git.example.test/gitlab",
      }),
    ).toMatchObject({ instanceUrl: "https://gitlab.com", projectPath: "acme/widgets" });
  });

  test("does not guess unknown hosts", () => {
    expect(parseGitRemoteUrl("git@source.example.test:acme/widgets.git")).toBeNull();
  });

  test("rejects malformed and traversal paths", () => {
    expect(parseGitRemoteUrl("git@github.com:widgets.git")).toBeNull();
    expect(parseGitRemoteUrl("git@gitlab.com:acme/../widgets.git")).toBeNull();
  });
});

describe("parseChangeRequestUrl", () => {
  test("parses GitHub, Bitbucket, and GitLab URLs", () => {
    expect(parseChangeRequestUrl("https://github.com/acme/widgets/pull/12")).toMatchObject({
      provider: "github",
      projectPath: "acme/widgets",
      number: 12,
    });
    expect(
      parseChangeRequestUrl("https://bitbucket.org/acme/widgets/pull-requests/13"),
    ).toMatchObject({ provider: "bitbucket", projectPath: "acme/widgets", number: 13 });
    expect(
      parseChangeRequestUrl("https://gitlab.com/acme/platform/widgets/-/merge_requests/14"),
    ).toMatchObject({ provider: "gitlab", projectPath: "acme/platform/widgets", number: 14 });
  });

  test("accepts provider detail pages and fragments", () => {
    expect(parseChangeRequestUrl("https://github.com/acme/widgets/pull/12/files")).toMatchObject({
      provider: "github",
      number: 12,
    });
    expect(
      parseChangeRequestUrl("https://gitlab.com/acme/widgets/-/merge_requests/14/diffs#note_123"),
    ).toMatchObject({ provider: "gitlab", number: 14 });
  });

  test("parses a self-managed URL below its installation path", () => {
    expect(
      parseChangeRequestUrl("https://git.example.test/gitlab/acme/widgets/-/merge_requests/9", {
        gitlabBaseUrl: "https://git.example.test/gitlab",
      }),
    ).toMatchObject({
      provider: "gitlab",
      instanceUrl: "https://git.example.test/gitlab",
      projectPath: "acme/widgets",
      number: 9,
    });
  });

  test("rejects issue and unknown-host URLs", () => {
    expect(parseChangeRequestUrl("https://github.com/acme/widgets/issues/1")).toBeNull();
    expect(
      parseChangeRequestUrl("https://unknown.test/acme/widgets/-/merge_requests/1"),
    ).toBeNull();
  });
});

describe("code-host configuration parsing", () => {
  test("normalizes instance URLs and aliases", () => {
    expect(normalizeCodeHostUrl("git.example.test/gitlab/")).toBe(
      "https://git.example.test/gitlab",
    );
    expect(parseGitLabHostAliases("corp-git, mirror ,,")).toEqual(["corp-git", "mirror"]);
  });
});
