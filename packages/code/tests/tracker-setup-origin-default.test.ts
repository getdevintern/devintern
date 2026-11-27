import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runTrackerSetup } from "../src/lib/init/wizard";

describe("runTrackerSetup step defaults", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tracker-setup-origin-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(stepDefaults?: Record<string, string>, repoAnswer = "") {
    const asked: string[] = [];
    let written = "";
    const result = await runTrackerSetup(
      async (question) => {
        asked.push(question);
        if (question.startsWith("Enter a number")) return "github";
        if (question.startsWith("Target repository")) return repoAnswer;
        return "";
      },
      () => {},
      async () => {},
      dir,
      {
        stepDefaults,
        promptSecret: async () => "ghp_test_token",
        githubCliToken: () => null,
        writeEnv: async (content) => {
          written = content;
          return join(dir, ".env");
        },
      },
    );
    return { result, asked, written };
  }

  test("the Target repository prompt defaults to origin's owner/repo", async () => {
    const { result, asked, written } = await run({ GITHUB_REPO: "acme/app" });
    expect(asked.find((q) => q.startsWith("Target repository"))).toContain("acme/app");
    expect(result?.values.GITHUB_REPO).toBe("acme/app");
    expect(written).toContain("GITHUB_REPO=acme/app");
  });

  test("a typed answer wins over the default", async () => {
    const { result } = await run({ GITHUB_REPO: "acme/app" }, "other/repo");
    expect(result?.values.GITHUB_REPO).toBe("other/repo");
  });
});
