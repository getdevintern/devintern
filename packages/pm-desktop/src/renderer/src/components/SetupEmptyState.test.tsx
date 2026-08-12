import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InvalidProjectBanner,
  InvalidProjectEmptyState,
  SetupBanner,
  SetupEmptyState,
  Welcome,
} from "./SetupEmptyState.tsx";
import { qk } from "../queries/keys.ts";
import { createTestQueryClient, withQueryClient } from "../test-helpers/query-client.tsx";

const noop = () => {};

describe("Welcome", () => {
  test("offers Connect GitHub as primary and open-folder as advanced", () => {
    const client = createTestQueryClient();
    client.setQueryData(qk.recentProjects, []);
    const html = renderToStaticMarkup(
      withQueryClient(
        createElement(Welcome, {
          onConnectGitHub: noop,
          onChooseProject: noop,
          loading: false,
        }),
        client,
      ),
    );
    expect(html).toContain('data-testid="welcome-screen"');
    expect(html).toContain('data-testid="welcome-connect"');
    expect(html).toContain("Connect GitHub repository");
    expect(html).toContain("managed clone");
    expect(html).toContain('data-testid="welcome-choose"');
    expect(html).toContain("Open existing folder");
    expect(html).not.toContain("Choose project directory");
    expect(html).not.toContain("devpm init");
    expect(html).not.toContain('data-testid="welcome-loading-status"');
  });

  test("shows spinner and restore status while loading", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        createElement(Welcome, {
          onConnectGitHub: noop,
          onChooseProject: noop,
          loading: true,
        }),
      ),
    );
    expect(html).toContain('data-testid="welcome-connect"');
    expect(html).toContain("Opening project…");
    expect(html).toContain('data-testid="welcome-loading-status"');
    expect(html).toContain("Syncing git and loading tracker settings");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Connect GitHub repository");
  });

  test("shows a clear empty state when there are no recent projects", () => {
    const client = createTestQueryClient();
    client.setQueryData(qk.recentProjects, []);
    const html = renderToStaticMarkup(
      withQueryClient(
        createElement(Welcome, {
          onConnectGitHub: noop,
          onChooseProject: noop,
          loading: false,
          recentProjects: [],
        }),
        client,
      ),
    );
    expect(html).toContain('data-testid="welcome-recent-projects"');
    expect(html).toContain('data-testid="recent-projects-empty"');
    expect(html).toContain("No recent projects yet");
  });

  test("omits empty-state copy while recent projects have not loaded yet", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        createElement(Welcome, {
          onConnectGitHub: noop,
          onChooseProject: noop,
          loading: false,
          recentProjects: null,
        }),
      ),
    );
    expect(html).toContain('data-testid="welcome-recent-projects"');
    expect(html).not.toContain('data-testid="recent-projects-empty"');
    expect(html).not.toContain("No recent projects yet");
  });

  test("does not claim empty recents while loading during last-project restore", () => {
    const html = renderToStaticMarkup(
      withQueryClient(
        createElement(Welcome, {
          onConnectGitHub: noop,
          onChooseProject: noop,
          loading: true,
          recentProjects: null,
        }),
      ),
    );
    expect(html).toContain('data-testid="welcome-loading-status"');
    expect(html).toContain("Opening project…");
    expect(html).not.toContain('data-testid="recent-projects-empty"');
    expect(html).not.toContain("No recent projects yet");
  });

  test("lists recent projects for quick reopen", () => {
    const projects = ["/work/alpha", "/work/beta"];
    const client = createTestQueryClient();
    client.setQueryData(qk.recentProjects, projects);
    const html = renderToStaticMarkup(
      withQueryClient(
        createElement(Welcome, {
          onConnectGitHub: noop,
          onChooseProject: noop,
          loading: false,
          recentProjects: projects,
          onOpenRecentProject: noop,
        }),
        client,
      ),
    );
    expect(html).toContain('data-testid="welcome-recent-projects"');
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).not.toContain('data-testid="recent-projects-empty"');
  });
});

describe("InvalidProjectBanner", () => {
  test("explains missing git and offers choose-folder CTA, not setup", () => {
    const html = renderToStaticMarkup(
      createElement(InvalidProjectBanner, { onChangeProject: noop }),
    );
    expect(html).toContain('data-testid="invalid-project-banner"');
    expect(html).toContain('data-testid="invalid-project-banner-cta"');
    expect(html).toContain("Not a valid project folder");
    expect(html).toContain("git repository");
    expect(html).toContain("Choose different folder");
    expect(html).not.toContain("Set up project");
    expect(html).not.toContain("needs PM setup");
  });
});

describe("InvalidProjectEmptyState", () => {
  test("blocks issue workflows and points at choosing a git project", () => {
    const html = renderToStaticMarkup(
      createElement(InvalidProjectEmptyState, { onChangeProject: noop }),
    );
    expect(html).toContain('data-testid="invalid-project-empty"');
    expect(html).toContain('data-testid="invalid-project-choose"');
    expect(html).toContain("not ready for PM");
    expect(html).toContain("git repository");
    expect(html).not.toContain("Open a ticket");
    expect(html).not.toContain("Set up project");
  });
});

describe("SetupBanner", () => {
  test("offers in-app setup as the primary path for valid git projects", () => {
    const html = renderToStaticMarkup(createElement(SetupBanner, { onSetup: noop }));
    expect(html).toContain('data-testid="setup-banner"');
    expect(html).toContain('data-testid="setup-banner-cta"');
    expect(html).toContain("Project needs PM setup");
    expect(html).toContain("Set up project");
    expect(html).toContain("valid git project");
    expect(html).not.toContain("Not a valid project folder");
    expect(html).not.toContain("devpm init");
    expect(html).not.toContain(".env");
    expect(html).not.toContain("JIRA_");
    expect(html).not.toContain("environment variable");
  });

  test("suggests header tracker switch when another tracker is ready", () => {
    const html = renderToStaticMarkup(
      createElement(SetupBanner, { onSetup: noop, canRecoverViaTrackerSwitch: true }),
    );
    expect(html).toContain("Another tracker looks ready");
    expect(html).not.toContain(".env");
    expect(html).not.toContain("devpm init");
  });
});

describe("SetupEmptyState", () => {
  test("prompts in-app setup instead of opening tickets", () => {
    const html = renderToStaticMarkup(createElement(SetupEmptyState, { onSetup: noop }));
    expect(html).toContain('data-testid="setup-empty"');
    expect(html).toContain('data-testid="setup-empty-cta"');
    expect(html).toContain("Finish PM setup");
    expect(html).toContain("Set up project");
    expect(html).toContain("git project");
    expect(html).not.toContain("Open a ticket");
    expect(html).not.toContain("devpm init");
  });
});
