import { expect, test } from "bun:test";
import { resolveBitbucketConfig, resolveGitLabComConfig } from "../../helpers/hosted-config";

test("hosted suites require their own tokens and never reuse production or local credentials", () => {
  expect(() =>
    resolveBitbucketConfig({
      E2E_BITBUCKET_REPOSITORY: "workspace/fixture",
      BITBUCKET_TOKEN: "production-token",
    }),
  ).toThrow("E2E_BITBUCKET_TOKEN");
  expect(() =>
    resolveGitLabComConfig({
      E2E_GITLAB_COM_PROJECT: "group/fixture",
      E2E_GITLAB_TOKEN: "local-token",
      GITLAB_TOKEN: "production-token",
    }),
  ).toThrow("E2E_GITLAB_COM_TOKEN");
});

test("GitLab.com accepts nested namespaces; Bitbucket requires workspace/repo", () => {
  expect(
    resolveGitLabComConfig({
      E2E_GITLAB_COM_PROJECT: "group/subgroup/fixture",
      E2E_GITLAB_COM_TOKEN: "test-token",
    }),
  ).toEqual({ projectPath: "group/subgroup/fixture", token: "test-token" });
  expect(() =>
    resolveBitbucketConfig({
      E2E_BITBUCKET_REPOSITORY: "workspace/group/repo",
      E2E_BITBUCKET_TOKEN: "test-token",
    }),
  ).toThrow("repository path");
});

test("hosted configuration rejects URLs and path traversal before contacting a service", () => {
  for (const path of [
    "https://gitlab.com/group/repo",
    "group/../repo",
    "group/./repo",
    "group//repo",
  ]) {
    expect(() =>
      resolveGitLabComConfig({ E2E_GITLAB_COM_PROJECT: path, E2E_GITLAB_COM_TOKEN: "test-token" }),
    ).toThrow("repository path");
  }
});
