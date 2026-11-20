import { expect, test } from "bun:test";
import { assertGitLabOrigin } from "../src/lib/code-host/change-origin";
import type { ChangeRequestIdentity } from "../src/lib/code-host";

const identity: ChangeRequestIdentity = {
  provider: "gitlab",
  instanceUrl: "https://gitlab.example",
  projectPath: "group/sub/project",
  number: 17,
  webUrl: "https://gitlab.example/group/sub/project/-/merge_requests/17",
};
const options = { gitlabBaseUrl: identity.instanceUrl, gitlabHostAliases: ["work-gitlab"] };

test.each([
  "https://gitlab.example/group/sub/project.git",
  "git@work-gitlab:group/sub/project.git",
])("accepts matching origin %s", (remote) => {
  expect(() => assertGitLabOrigin(identity, remote, options)).not.toThrow();
});
test("accepts a split-port clone of the configured instance", () => {
  // The git endpoint may be on a different port from the web/API endpoint; the
  // origin guard (and PR detection) must still resolve it as this instance.
  const splitIdentity: ChangeRequestIdentity = {
    ...identity,
    instanceUrl: "https://git.example.test",
    webUrl: "https://git.example.test/group/sub/project/-/merge_requests/17",
  };
  expect(() =>
    assertGitLabOrigin(splitIdentity, "https://git.example.test:8443/group/sub/project.git", {
      gitlabBaseUrl: splitIdentity.instanceUrl,
    }),
  ).not.toThrow();
});
test.each([
  null,
  "",
  "https://other.example/group/sub/project.git",
  "git@work-gitlab:group/other.git",
  "git@github.com:group/project.git",
])("rejects mismatched or unavailable origin %s", (remote) => {
  expect(() => assertGitLabOrigin(identity, remote, options)).toThrow(
    "The current origin does not match GitLab project",
  );
});
