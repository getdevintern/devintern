import { describe, expect, test } from "bun:test";

import { classifyPushProbe } from "../src/lib/github-push-probe";

const DENIED = [
  "remote: Permission to getdevintern/devintern.git denied to danii1.",
  "fatal: unable to access 'https://github.com/getdevintern/devintern/':",
  "The requested URL returned error: 403",
].join("\n");

describe("classifyPushProbe", () => {
  test("reports ok on a successful dry run", () => {
    const result = classifyPushProbe(
      true,
      "To https://github.com/getdevintern/devintern\n * [new branch]      HEAD -> __devintern_push_probe__\n",
    );
    expect(result.status).toBe("ok");
  });

  test("classifies GitHub denial output as a permission failure", () => {
    expect(classifyPushProbe(false, "", DENIED).status).toBe("permission");
  });

  test("classifies bare 403 lines as a permission failure", () => {
    expect(classifyPushProbe(false, "error: RPC failed; 403 Forbidden").status).toBe("permission");
    expect(classifyPushProbe(false, "The requested URL returned error: 401").status).toBe(
      "permission",
    );
  });

  test("classifies DNS/connect failures as network problems", () => {
    const network = classifyPushProbe(
      false,
      "",
      "fatal: unable to access 'https://github.com/getdevintern/devintern/': Failed to connect to github.com:443 after 132535 ms: Could not connect to server",
    );
    expect(network.status).toBe("network");
    expect(classifyPushProbe(false, "Could not resolve host: github.com").status).toBe("network");
  });

  test("keeps unknown failures unknown", () => {
    expect(classifyPushProbe(false, "", "some unexpected git crash").status).toBe("unknown");
  });

  test("redacts embedded basic-auth credentials from remote URLs", () => {
    const result = classifyPushProbe(
      false,
      "",
      "remote: Permission to git@github.com denied — https://x-access-token:ghs_secret@github.com/getdevintern/devintern.git",
    );
    expect(result.message).not.toContain("ghs_secret");
  });
});
