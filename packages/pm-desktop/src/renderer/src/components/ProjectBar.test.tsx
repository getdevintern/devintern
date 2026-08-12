import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectBar } from "./ProjectBar.tsx";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";
import { withQueryClient } from "../test-helpers/query-client.tsx";
import { resetProjectStore, useProjectStore } from "../state/project-store.ts";
import {
  resetTicketWorkspacesStore,
  useTicketWorkspacesStore,
} from "../state/ticket-workspaces-store.ts";
import { createTicketWorkspace } from "../state/ticket-workspaces.ts";
import { initialOutputState } from "../state/app-store.ts";

const noop = () => {};

function seedBusyTicket(): void {
  const ticket = createTicketWorkspace("busy-1");
  useTicketWorkspacesStore.setState({
    tickets: [{ ...ticket, output: { ...initialOutputState, phase: "generating" } }],
    activeTicketId: ticket.id,
  });
}

function render(
  status: ProjectStatus,
  options?: {
    agentRunning?: boolean;
    switching?: boolean;
    recentProjects?: string[];
    updatingFromRemote?: boolean;
    onUpdateFromRemote?: () => void;
    onConnectGitHub?: () => void;
    onChangeTrackerSettings?: () => void;
  },
): string {
  // Seed the project chrome store so ProjectBar reads status / flags without props.
  useProjectStore.setState({
    status,
    loadingProject: options?.switching ?? false,
    updatingFromRemote: options?.updatingFromRemote ?? false,
    chromeError: null,
  });
  if (options?.agentRunning) seedBusyTicket();
  return renderToStaticMarkup(
    withQueryClient(
      createElement(ProjectBar, {
        onConnectGitHub: options?.onConnectGitHub,
        onChangeProject: noop,
        recentProjects: options?.recentProjects,
        onOpenRecentProject: noop,
        onSwitchTracker: noop,
        onSwitchProjectKey: noop,
        onSwitchHarness: noop,
        onChangeTrackerSettings: options?.onChangeTrackerSettings,
        onUpdateFromRemote: options?.onUpdateFromRemote,
      }),
    ),
  );
}

beforeEach(() => {
  resetProjectStore();
  resetTicketWorkspacesStore();
});
afterEach(() => {
  resetProjectStore();
  resetTicketWorkspacesStore();
});

describe("ProjectBar", () => {
  test("labels tracker, project, and harness in read-only chips", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      backendName: "Jira",
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
      ],
      defaultProjectKey: "ACME",
      supportsProjectSwitch: true,
      projects: [{ key: "ACME", name: "Acme" }],
      harnessDisplayName: "Claude Code",
      gitSync: {
        kind: "ok",
        softDirty: false,
        branch: "feature/demo",
        message: "You're up to date.",
      },
    });

    expect(html).toContain("Tracker");
    expect(html).toContain("Jira");
    expect(html).toContain('aria-label="Task tracker: Jira"');
    expect(html).toContain("Project");
    expect(html).toContain("Acme (ACME)");
    expect(html).toContain('aria-label="Project: Acme (ACME)"');
    expect(html).toContain("Harness");
    expect(html).toContain("Claude Code");
    expect(html).toContain('aria-label="Harness: Claude Code"');
    expect(html).not.toContain('aria-label="Switch task tracker"');
    expect(html).toContain('data-testid="git-branch"');
    expect(html).toContain("feature/demo");
    expect(html).toContain('aria-label="Current branch: feature/demo"');
  });

  test("shows a tracker switcher when multiple trackers are configured", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
        { id: "linear", displayName: "Linear", projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY" },
      ],
    });

    expect(html).toContain("Tracker");
    expect(html).toContain('aria-label="Task tracker: Jira"');
    expect(html).toContain('title="Switch task tracker"');
  });

  test("offers a switcher when the active tracker failed but another is configured", () => {
    const html = render({
      projectDir: "/repo",
      configured: false,
      isGitRepository: true,
      configError: "Missing JIRA_API_TOKEN",
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "linear", displayName: "Linear", projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY" },
      ],
    });

    expect(html).toContain('aria-label="Task tracker: Jira"');
  });

  test("labels projects unavailable when listing failed", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
      ],
      supportsProjectSwitch: true,
      projectsError: "API down",
    });

    expect(html).toContain("Project");
    expect(html).toContain("Projects unavailable");
    expect(html).toContain('aria-label="Project: Projects unavailable"');
  });

  test("shows a project switcher when multiple projects are available", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
      ],
      defaultProjectKey: "ACME",
      supportsProjectSwitch: true,
      projects: [
        { key: "ACME", name: "Acme" },
        { key: "BETA", name: "Beta" },
      ],
    });

    expect(html).toContain("Project");
    expect(html).toContain("Acme (ACME)");
    expect(html).toContain('title="Switch project"');
    expect(html).toContain('aria-label="Project: Acme (ACME)"');
  });

  test("labels project switcher including select-project empty state", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
      ],
      supportsProjectSwitch: true,
      projects: [
        { key: "ACME", name: "Acme" },
        { key: "BETA", name: "Beta" },
      ],
    });

    expect(html).toContain("Project");
    expect(html).toContain("Select project");
    expect(html).toContain('aria-label="Project: Select project"');
  });

  test("keeps harness read-only when only one harness is available", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      activeHarnessName: "claude-code",
      harnessDisplayName: "Claude Code",
      availableHarnesses: [{ name: "claude-code", displayName: "Claude Code" }],
    });

    expect(html).toContain("Harness");
    expect(html).toContain("Claude Code");
    expect(html).toContain('aria-label="Harness: Claude Code"');
    expect(html).not.toContain('title="Switch agent harness"');
  });

  test("shows a harness switcher when multiple harnesses are available", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      activeHarnessName: "claude-code",
      harnessDisplayName: "Claude Code",
      availableHarnesses: [
        { name: "claude-code", displayName: "Claude Code" },
        { name: "opencode", displayName: "OpenCode" },
      ],
    });

    expect(html).toContain("Harness");
    expect(html).toContain('aria-label="Harness: Claude Code"');
    expect(html).toContain('title="Switch agent harness"');
  });

  test("disables harness switcher while an agent run is in progress", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        activeHarnessName: "claude-code",
        harnessDisplayName: "Claude Code",
        availableHarnesses: [
          { name: "claude-code", displayName: "Claude Code" },
          { name: "opencode", displayName: "OpenCode" },
        ],
      },
      { agentRunning: true },
    );

    // Stay on the dropdown (not a read-only badge) so the reason is visible.
    expect(html).toContain('aria-label="Harness: Claude Code"');
    expect(html).toContain('title="Unavailable while an agent is running"');
    expect(html).not.toContain('title="Switch agent harness"');
  });

  test("disables tracker, project, and Change Project while an agent run is in progress", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        activeTrackerId: "jira",
        activeTrackerDisplayName: "Jira",
        configuredTrackers: [
          { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
          { id: "linear", displayName: "Linear", projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY" },
        ],
        defaultProjectKey: "ACME",
        supportsProjectSwitch: true,
        projects: [
          { key: "ACME", name: "Acme" },
          { key: "BETA", name: "Beta" },
        ],
        activeHarnessName: "claude-code",
        harnessDisplayName: "Claude Code",
        availableHarnesses: [
          { name: "claude-code", displayName: "Claude Code" },
          { name: "opencode", displayName: "OpenCode" },
        ],
      },
      { agentRunning: true },
    );

    expect(html).toContain('aria-label="Task tracker: Jira"');
    expect(html).toContain('aria-label="Project: Acme (ACME)"');
    expect(html).toContain('title="Unavailable while an agent is running"');
    expect(html).not.toContain('title="Switch task tracker"');
    expect(html).not.toContain('title="Switch project"');
    expect(html).not.toContain('title="Recent projects and open folder"');
  });

  test("exposes a Recent projects directory menu on the folder control", () => {
    // Menu body is portal content (not in closed SSR markup); assert the trigger.
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
    });

    expect(html).toContain('aria-label="Project: repo"');
    expect(html).toContain("Connect GitHub repository or open folder");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain(">repo<");
  });

  test("prefers GitHub remote label for bound projects", () => {
    const html = render(
      {
        projectDir: "/home/user/.config/DevIntern PM/projects/acme-web-abcd",
        configured: true,
        isGitRepository: true,
        projectBinding: {
          id: "abcd",
          remote: "acme/web",
          localPath: "/home/user/.config/DevIntern PM/projects/acme-web-abcd",
          managed: true,
          lastFetch: 1,
        },
      },
      { onConnectGitHub: noop },
    );

    expect(html).toContain('aria-label="Project: acme/web"');
    expect(html).toContain(">acme/web<");
  });

  test("hides tracker and project controls when the folder is not a git repository", () => {
    const html = render({
      projectDir: "/not-a-repo",
      configured: true,
      isGitRepository: false,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      harnessDisplayName: "Claude Code",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
        { id: "linear", displayName: "Linear", projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY" },
      ],
      defaultProjectKey: "ACME",
      supportsProjectSwitch: true,
      projects: [
        { key: "ACME", name: "Acme" },
        { key: "OTHER", name: "Other" },
      ],
    });

    expect(html).toContain("not-a-repo");
    expect(html).not.toContain('aria-label="Switch task tracker"');
    expect(html).not.toContain('aria-label="Switch project"');
    expect(html).not.toContain("Jira");
    expect(html).not.toContain("Claude Code");
  });

  test("shows behind status and enabled Update when soft-dirty", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        gitSync: {
          kind: "behind",
          softDirty: true,
          branch: "feature/demo",
          behind: 2,
          message: "2 updates available.",
        },
      },
      { onUpdateFromRemote: noop },
    );

    expect(html).toContain('data-testid="git-branch"');
    expect(html).toContain("feature/demo");
    expect(html).toContain('data-testid="git-sync-status"');
    expect(html).toContain("2 updates");
    expect(html).not.toContain("Local edits");
    expect(html).not.toContain("Setup file");
    const updateBtn = html.match(/<button\b[^>]*data-testid="update-from-remote"[^>]*>/)?.[0];
    expect(updateBtn).toBeTruthy();
    expect(updateBtn).toContain('aria-label="Get latest changes"');
    expect(updateBtn).not.toContain("disabled=");
    expect(html).toContain("Get updates");
  });

  test("shows enabled Get updates when hard-dirty skipped so users can retry", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        gitSync: {
          kind: "skipped_dirty",
          softDirty: false,
          behind: 1,
          message: "You have unsaved local edits, so getting updates was skipped.",
        },
      },
      { onUpdateFromRemote: noop },
    );

    expect(html).toContain("1 update · local edits");
    const updateBtn = html.match(/<button\b[^>]*data-testid="update-from-remote"[^>]*>/)?.[0];
    expect(updateBtn).toBeTruthy();
    expect(updateBtn).not.toContain("disabled=");
    expect(updateBtn).toContain("You have unsaved local edits, so getting updates was skipped.");
  });

  test("hides Get updates when there is no remote", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        gitSync: {
          kind: "no_remote",
          softDirty: true,
          message: "This project isn't linked to an online repository yet.",
        },
      },
      { onUpdateFromRemote: noop },
    );

    expect(html).toContain("Not linked online");
    expect(html).not.toContain('data-testid="update-from-remote"');
  });

  test("shows enabled Get updates after sync error so users can retry", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        gitSync: {
          kind: "error",
          softDirty: false,
          message: "Couldn't download updates. network unreachable",
        },
      },
      { onUpdateFromRemote: noop },
    );

    expect(html).toContain("Couldn&#x27;t get updates");
    const updateBtn = html.match(/<button\b[^>]*data-testid="update-from-remote"[^>]*>/)?.[0];
    expect(updateBtn).toBeTruthy();
    expect(updateBtn).not.toContain("disabled=");
    // Apostrophe is HTML-escaped in the title attribute.
    expect(updateBtn).toContain("Couldn&#x27;t download updates. network unreachable");
  });

  test("tracker chip stays read-only when only one tracker is configured and no settings callback", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      activeTrackerId: "jira",
      activeTrackerDisplayName: "Jira",
      configuredTrackers: [
        { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
      ],
    });

    expect(html).toContain('aria-label="Task tracker: Jira"');
    expect(html).not.toContain('title="Switch task tracker"');
    expect(html).not.toContain('data-testid="tracker-change-settings"');
  });

  test("offers the Add or change tracker entry point even with a single configured tracker", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        activeTrackerId: "markdown",
        activeTrackerDisplayName: "Markdown files",
        configuredTrackers: [{ id: "markdown", displayName: "Markdown files" }],
      },
      { onChangeTrackerSettings: noop },
    );

    // The chip becomes a dropdown so the post-init settings entry point is
    // reachable. (Menu body is portal-rendered; assert on the trigger button.)
    expect(html).toContain('aria-label="Task tracker: Markdown files"');
    expect(html).toContain('title="Switch task tracker"');
  });

  test("lists configured trackers and the settings entry point together", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        activeTrackerId: "jira",
        activeTrackerDisplayName: "Jira",
        configuredTrackers: [
          { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
          { id: "linear", displayName: "Linear", projectKeyEnv: "LINEAR_DEFAULT_TEAM_KEY" },
        ],
      },
      { onChangeTrackerSettings: noop },
    );

    // The chip stays a dropdown (configured trackers + settings entry point).
    expect(html).toContain('title="Switch task tracker"');
    expect(html).toContain('aria-label="Task tracker: Jira"');
  });

  test("disables the Add or change tracker entry point while an agent is running", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        activeTrackerId: "jira",
        activeTrackerDisplayName: "Jira",
        configuredTrackers: [
          { id: "jira", displayName: "Jira", projectKeyEnv: "JIRA_DEFAULT_PROJECT_KEY" },
        ],
      },
      { onChangeTrackerSettings: noop, agentRunning: true },
    );

    expect(html).toContain('title="Unavailable while an agent is running"');
    // The dropdown stays mounted (so the reason is visible) but is disabled.
    expect(html).toContain('aria-label="Task tracker: Jira"');
  });
});
