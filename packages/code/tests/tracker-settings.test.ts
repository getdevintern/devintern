import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseWorkspaceConfig } from "../src/lib/workspace/config";
import {
  loadWorkspaceTrackerSettings,
  mergeTrackerSettings,
  parseTrackerSettings,
} from "../src/lib/workspace/tracker-settings";
import { parseToml } from "../src/lib/workspace/toml";

const TRACKERS = `
[trackers.jira.projects.DEV]
in_progress_status = "In Progress"
todo_status = "To Do"
pr_status = "In Review"
story_points_field = "customfield_10016"

[trackers.azure-devops.projects."My Project"]
pr_status = "Resolved"
`;

function parse(text: string): {
  settings: ReturnType<typeof parseTrackerSettings>;
  errors: string[];
} {
  const errors: string[] = [];
  const settings = parseTrackerSettings(parseToml(text).trackers, errors);
  return { settings, errors };
}

describe("parseTrackerSettings", () => {
  test("maps snake_case keys to the settings.json shape", () => {
    const { settings, errors } = parse(TRACKERS);
    expect(errors).toEqual([]);
    expect(settings.jira?.projects?.DEV).toEqual({
      inProgressStatus: "In Progress",
      todoStatus: "To Do",
      prStatus: "In Review",
      storyPointsField: "customfield_10016",
    });
    expect(settings["azure-devops"]?.projects?.["My Project"]).toEqual({ prStatus: "Resolved" });
  });

  test("reports unknown trackers, keys, and non-string values", () => {
    const { errors } = parse(`
[trackers.jirra.projects.DEV]
pr_status = "x"

[trackers.jira]
statuses = {}

[trackers.jira.projects.DEV]
prStatus = "x"
todo_status = 3
`);
    expect(errors).toHaveLength(4);
    expect(errors.join("\n")).toContain("[trackers.jirra] is not a known tracker");
    expect(errors.join("\n")).toContain('[trackers.jira]: "statuses" is not supported');
    expect(errors.join("\n")).toContain(
      '[trackers.jira.projects.DEV]: "prStatus" is not supported',
    );
    expect(errors.join("\n")).toContain('"todo_status" must be a non-empty string');
  });

  test("parseWorkspaceConfig validates and exposes [trackers]", () => {
    const base = '[defaults]\ntracker = "jira"\n';
    expect(
      parseWorkspaceConfig(base + TRACKERS).trackerSettings?.jira?.projects?.DEV?.prStatus,
    ).toBe("In Review");
    expect(() => parseWorkspaceConfig(base + '[trackers.jira.projects.DEV]\nbad = "x"\n')).toThrow(
      /"bad" is not supported/,
    );
  });
});

describe("loadWorkspaceTrackerSettings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tracker-settings-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null without a workspace.toml or [trackers]", () => {
    expect(loadWorkspaceTrackerSettings(dir)).toBeNull();
    writeFileSync(join(dir, "workspace.toml"), '[defaults]\ntracker = "jira"\n');
    expect(loadWorkspaceTrackerSettings(dir)).toBeNull();
  });

  test("reads [trackers] and ignores an invalid table with a warning", () => {
    writeFileSync(join(dir, "workspace.toml"), TRACKERS);
    expect(loadWorkspaceTrackerSettings(dir)?.jira?.projects?.DEV?.todoStatus).toBe("To Do");

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "workspace.toml"), '[trackers.nope.projects.X]\npr_status = "x"\n');
      expect(loadWorkspaceTrackerSettings(dir)).toBeNull();
      expect(String(warn.mock.calls[0]?.[0])).toContain("Ignoring [trackers]");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("mergeTrackerSettings", () => {
  test("workspace project keys win; legacy-only keys and fields are kept", () => {
    const merged = mergeTrackerSettings(
      { jira: { projects: { DEV: { prStatus: "Review" } } } },
      {
        jira: { projects: { DEV: { prStatus: "Old" }, OPS: { prStatus: "Done" } } },
        projects: { LEGACY: { prStatus: "L" } },
        pipeline: { steps: [{ use: "implement" }] },
      },
    );
    expect(merged?.jira?.projects?.DEV?.prStatus).toBe("Review");
    expect(merged?.jira?.projects?.OPS?.prStatus).toBe("Done");
    expect(merged?.projects?.LEGACY?.prStatus).toBe("L");
    expect(merged?.pipeline?.steps).toHaveLength(1);
  });

  test("returns whichever side exists", () => {
    const only = { jira: { projects: { A: {} } } };
    expect(mergeTrackerSettings(null, only)).toBe(only);
    expect(mergeTrackerSettings(only, null)).toBe(only);
    expect(mergeTrackerSettings(null, null)).toBeNull();
  });
});
