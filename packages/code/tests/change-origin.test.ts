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
