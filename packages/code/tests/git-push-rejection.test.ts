import { describe, expect, test } from "bun:test";
import {
  describeRemotePushRejection,
  findRemotePushRejection,
} from "../src/lib/utils/git-push-rejection";

const BRANCH = "feature/local-ci-wait-longer-for-npm-before-the-post-r";

describe("findRemotePushRejection", () => {
  test("extracts the workflow file from GitHub's token scope refusal", () => {
    const output = [
      "To https://github.com/getdevintern/devintern",
      ` ! [remote rejected] HEAD -> ${BRANCH} (refusing to allow a Personal Access Token to create or update workflow \`.github/workflows/onboarding-golden-path.yml\` without \`workflow\` scope)`,
      "error: failed to push some refs to 'https://github.com/getdevintern/devintern'",
    ].join("\n");

    const rejection = findRemotePushRejection(output, BRANCH);

    expect(rejection?.workflowFile).toBe(".github/workflows/onboarding-golden-path.yml");
    const message = describeRemotePushRejection(rejection!, BRANCH);
    expect(message).toContain("`workflow` scope");
    expect(message).toContain("Workflows read and write");
    expect(message).toContain(".github/workflows/onboarding-golden-path.yml");
    expect(message).not.toContain("To https://");
  });

  test("handles a reason wrapped across lines and the GitHub App wording", () => {
    const output = ` ! [remote rejected] HEAD -> refs/heads/${BRANCH}\n(refusing to allow a GitHub App to create or update workflow\n\`.github/workflows/ci.yml\` without \`workflows\` permission)`;

    const rejection = findRemotePushRejection(output, BRANCH);

    expect(rejection?.workflowFile).toBe(".github/workflows/ci.yml");
    expect(rejection?.reason).not.toContain("\n");
  });

  test("returns other server reasons without workflow guidance", () => {
    const rejection = findRemotePushRejection(
      ` ! [remote rejected] ${BRANCH} -> ${BRANCH} (push declined due to repository rule violations)`,
      BRANCH,
    );

    expect(rejection?.workflowFile).toBeUndefined();
    expect(describeRemotePushRejection(rejection!, BRANCH)).toContain(
      "push declined due to repository rule violations",
    );
  });

  test("ignores a local pre-push hook failure and rejections of other refs", () => {
    expect(
      findRemotePushRejection("lint failed\nerror: failed to push some refs to 'origin'", BRANCH),
    ).toBeUndefined();
    expect(
      findRemotePushRejection(" ! [remote rejected] main -> main (fixture)", BRANCH),
    ).toBeUndefined();
    expect(
      findRemotePushRejection(` ! [rejected] ${BRANCH} -> ${BRANCH} (non-fast-forward)`, BRANCH),
    ).toBeUndefined();
  });
});
