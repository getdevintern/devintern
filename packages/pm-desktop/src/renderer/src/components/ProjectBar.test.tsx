import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectBar } from "./ProjectBar.tsx";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

const noop = () => {};

function render(status: ProjectStatus): string {
  return renderToStaticMarkup(
    createElement(ProjectBar, {
      status,
      onChangeProject: noop,
      onSwitchTracker: noop,
      onSwitchProjectKey: noop,
    }),
  );
}

describe("ProjectBar", () => {
  test("shows a non-interactive tracker badge when only one tracker is configured", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      backendName: "Jira",
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
      ],
      defaultProjectKey: "ACME",
      supportsProjectSwitch: true,
      projects: [{ key: "ACME", name: "Acme" }],
    });

    expect(html).toContain("Jira");
    expect(html).toContain("Acme");
    expect(html).not.toContain('aria-label="Switch task tracker"');
  });

  test("shows a tracker switcher when multiple trackers are configured", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
        { id: "linear", displayName: "Linear", projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY" },
      ],
    });

    expect(html).toContain('aria-label="Switch task tracker"');
  });

  test("offers a switcher when the active tracker failed but another is configured", () => {
    const html = render({
      projectDir: "/repo",
      configured: false,
      configError: "Missing JIRA_API_TOKEN",
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "linear", displayName: "Linear", projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY" },
      ],
    });

    expect(html).toContain('aria-label="Switch task tracker"');
  });

  test("shows projects unavailable when listing failed", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
      ],
      supportsProjectSwitch: true,
      projectsError: "API down",
    });

    expect(html).toContain("Projects unavailable");
  });
});
