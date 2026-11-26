import { describe, expect, test } from "bun:test";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import { workerWorkspaceView } from "../src/lib/workspace/manual-only";
import { findRepoForPath } from "../src/lib/workspace/manual-run";

const MANUAL_REPO = `
[[repos]]
name = "notes"
remote = "git@github.com:acme/notes.git"
manual_only = true
`;

describe("manual_only repos", () => {
  test("a workspace with only manual repos needs no [defaults].tracker", () => {
    const config = parseWorkspaceConfig(MANUAL_REPO);
    expect(config.repos[0]?.manualOnly).toBe(true);
  });

  test("a worker repo still requires [defaults].tracker", () => {
    const worker = `
[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
`;
    expect(() => parseWorkspaceConfig(MANUAL_REPO + worker)).toThrow(
      /\[defaults\]\.tracker is required/,
    );
  });

  test("the worker view drops manual repos and keeps the rest", () => {
    const config = parseWorkspaceConfig(`
[defaults]
tracker = "jira"
${MANUAL_REPO}
[[repos]]
name = "api"
remote = "git@github.com:acme/api.git"
`);
    expect(config.repos.map((repo) => repo.name)).toEqual(["notes", "api"]);
    expect(workerWorkspaceView(config).repos.map((repo) => repo.name)).toEqual(["api"]);
    const plain = parseWorkspaceConfig(
      '[defaults]\ntracker = "jira"\n[[repos]]\nname = "api"\nremote = "x"\n',
    );
    expect(workerWorkspaceView(plain)).toBe(plain);
  });

  test("worker work aimed at a manual repo is rejected", () => {
    expect(() =>
      parseWorkspaceConfig(`
[defaults]
tracker = "jira"
${MANUAL_REPO}
[[automations]]
id = "nightly"
enabled = true
interval = "1d"
repo = "notes"
prompt = "Tidy up"

[[routing.rules]]
repo = "notes"
project = "NOTE"
`),
    ).toThrow(/\[\[automations\]\] "nightly" targets "notes", which is manual_only/);
  });

  test("manual_only must be a boolean", () => {
    expect(() =>
      parseWorkspaceConfig('[[repos]]\nname = "x"\nremote = "y"\nmanual_only = "yes"\n'),
    ).toThrow(/manual_only/);
  });

  test("a manual repo can be registered by an absolute path instead of a remote", () => {
    const config = parseWorkspaceConfig(`
[[repos]]
name = "scratch"
path = "/home/me/scratch"
manual_only = true

[[repos]]
name = "nested"
path = "/home/me/scratch/inner"
manual_only = true
`);
    expect(config.repos[0]?.path).toBe("/home/me/scratch");
    expect(config.repos[0]?.remote).toBe("");
    expect(findRepoForPath(config, "/home/me/scratch/src")?.name).toBe("scratch");
    expect(findRepoForPath(config, "/home/me/scratch/inner/a")?.name).toBe("nested");
    expect(findRepoForPath(config, "/home/me/scratch-other")).toBeNull();
  });

  test("path is only for manual repos without a remote", () => {
    const bad = [
      '[[repos]]\nname = "a"\npath = "/x"\n',
      '[[repos]]\nname = "a"\npath = "relative"\nmanual_only = true\n',
      '[[repos]]\nname = "a"\npath = "/x"\nremote = "git@github.com:a/b.git"\nmanual_only = true\n',
    ];
    for (const text of bad) {
      expect(() => parseWorkspaceConfig('[defaults]\ntracker = "jira"\n' + text)).toThrow(
        /path must be an absolute directory/,
      );
    }
  });
});
