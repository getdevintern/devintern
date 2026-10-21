import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRepoSlug, redactReportText } from "../src/lib/report/redact";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "report-redact-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("report redaction", () => {
  test("scrubs credentials, paths, repo slugs, task keys, and emails", () => {
    const text = [
      "token=ghp_abcdefghijklmnopqrstuvwxyz",
      `path ${workdir}/src/index.ts`,
      "repo acme/private-app",
      "task PROJ-123 failed",
      "another OTHER-9 ticket",
      "contact someone@example.com",
      "\u001b[31mred\u001b[0m",
    ].join("\n");

    const redacted = redactReportText(text, {
      cwd: workdir,
      homeDir: "/home/example",
      repoSlug: "acme/private-app",
      taskKey: "PROJ-123",
    });

    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain(workdir);
    expect(redacted).not.toContain("acme/private-app");
    expect(redacted).not.toContain("PROJ-123");
    expect(redacted).not.toContain("OTHER-9");
    expect(redacted).not.toContain("someone@example.com");
    expect(redacted).not.toContain("\u001b[31m");
    expect(redacted).toContain("<repo>");
    expect(redacted).toContain("<task>");
    expect(redacted).toContain("<email>");
  });

  test("keeps identifier-shaped false positives", () => {
    expect(redactReportText("UTF-8 and ISO-8601", { cwd: workdir })).toContain("UTF-8");
    expect(redactReportText("UTF-8 and ISO-8601", { cwd: workdir })).toContain("ISO-8601");
  });

  test("keeps identifiers when the caller opts in", () => {
    const redacted = redactReportText("repo acme/app task PROJ-9", {
      cwd: workdir,
      repoSlug: "acme/app",
      taskKey: "PROJ-9",
      shareIdentifiers: true,
    });
    expect(redacted).toContain("acme/app");
    expect(redacted).toContain("PROJ-9");
  });

  test("parses HTTPS, SSH, and scp-like remotes", () => {
    expect(parseRepoSlug("https://github.com/acme/app.git")).toBe("acme/app");
    expect(parseRepoSlug("git@github.com:acme/app.git")).toBe("acme/app");
    expect(parseRepoSlug("ssh://git@gitlab.com/acme/app.git")).toBe("acme/app");
    expect(parseRepoSlug("not-a-remote")).toBeNull();
  });
});
