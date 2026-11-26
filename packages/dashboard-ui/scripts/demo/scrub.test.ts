import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createScrubber, loadSecretValues, scrubJson } from "./scrub";

const scrubber = createScrubber({
  secretValues: ["s3cr3t-value-from-env-file"],
  deny: ["acme/private-repo", "private-repo"],
});

test("scrubs known credential formats, env values, home paths, and emails", () => {
  const raw = [
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "gitlab glpat-abcdefghijklmnopqrst",
    "jira ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz",
    "value s3cr3t-value-from-env-file",
    `path ${homedir()}/work/repo`,
    "mail someone@example.com and noreply@anthropic.com",
    "url https://user:hunter2hunter2@git.example.com/x",
  ].join("\n");
  const out = scrubber.scrub(raw);
  expect(out).not.toContain("ghp_");
  expect(out).not.toContain("glpat-");
  expect(out).not.toContain("ATATT3");
  expect(out).not.toContain("s3cr3t-value");
  expect(out).not.toContain(homedir());
  expect(out).toContain("~/work/repo");
  expect(out).toContain("<email>");
  expect(out).toContain("noreply@anthropic.com");
  expect(out).not.toContain("hunter2");
  expect(scrubber.findLeaks(out)).toEqual([]);
});

test("flags what survives and names denied repositories by whole name", () => {
  expect(scrubber.findLeaks("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toEqual(["github token"]);
  expect(scrubber.mentionsDenied("cloned acme/private-repo today")).toBe(true);
  expect(scrubber.mentionsDenied("see private-repo#14")).toBe(true);
  expect(scrubber.mentionsDenied("a not-private-repo-ish word")).toBe(false);
  expect(scrubber.scrub("polling private-repo#14")).toBe("polling <private-repo>#14");
});

test("scrubs every string in a JSON value and keeps its shape", () => {
  expect(
    scrubJson({ a: ["x someone@example.com"], n: 3, nested: { b: "fine" } }, scrubber.scrub),
  ).toEqual({ a: ["x <email>"], n: 3, nested: { b: "fine" } });
});

test("loads only long dotenv values as secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-scrub-"));
  try {
    const file = join(dir, "a.env");
    writeFileSync(
      file,
      'TOKEN="abcdefghijklmnop"\nPORT=4400\nBASE_URL=https://example.atlassian.net\n# c\n',
    );
    expect(loadSecretValues([file])).toEqual(["abcdefghijklmnop"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
