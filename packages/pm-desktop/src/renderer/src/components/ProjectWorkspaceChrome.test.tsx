import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

mock.module("./ProjectSetupWizard.tsx", () => {
  const React = require("react");
  return {
    ProjectSetupWizard: () =>
      React.createElement("div", { "data-testid": "project-setup-wizard-host" }),
  };
});

const { ProjectWorkspaceChrome } = await import("./ProjectWorkspaceChrome.tsx");

const noop = () => {};

function baseStatus(overrides: Partial<ProjectStatus>): ProjectStatus {
  return {
    projectDir: "/repo",
    configured: false,
    isGitRepository: false,
    ...overrides,
  };
}

function render(status: ProjectStatus, setupOpen = false): string {
  return renderToStaticMarkup(
    <ProjectWorkspaceChrome
      status={status}
      setupOpen={setupOpen}
      onSetupOpenChange={noop}
      onSetupComplete={noop}
      onChangeProject={noop}
    >
      <div data-testid="ticket-workspace-chrome">tickets</div>
    </ProjectWorkspaceChrome>,
  );
}

describe("ProjectWorkspaceChrome suitability surfaces", () => {
  test("non-git: invalid banner/empty state, no setup, no wizard, no ticket chrome", () => {
    const html = render(
      baseStatus({
        isGitRepository: false,
        // Even if config somehow looks ready, unsuitable folders stay invalid.
        configured: true,
      }),
    );
    expect(html).toContain('data-testid="invalid-project-banner"');
    expect(html).toContain('data-testid="invalid-project-empty"');
    expect(html).not.toContain('data-testid="setup-banner"');
    expect(html).not.toContain('data-testid="project-setup-wizard-host"');
    expect(html).not.toContain('data-testid="ticket-workspace-chrome"');
  });

  test("git + unconfigured: setup banner + empty state + wizard host, no ticket chrome", () => {
    const html = render(
      baseStatus({
        isGitRepository: true,
        configured: false,
      }),
    );
    expect(html).toContain('data-testid="setup-banner"');
    expect(html).toContain('data-testid="setup-empty"');
    expect(html).toContain('data-testid="project-setup-wizard-host"');
    expect(html).not.toContain('data-testid="ticket-workspace-chrome"');
    expect(html).not.toContain('data-testid="invalid-project-banner"');
    expect(html).not.toContain('data-testid="invalid-project-empty"');
  });

  test("git + configured: ticket chrome + wizard host, no banners", () => {
    const html = render(
      baseStatus({
        isGitRepository: true,
        configured: true,
      }),
    );
    expect(html).toContain('data-testid="ticket-workspace-chrome"');
    expect(html).toContain('data-testid="project-setup-wizard-host"');
    expect(html).not.toContain('data-testid="setup-banner"');
    expect(html).not.toContain('data-testid="invalid-project-banner"');
    expect(html).not.toContain('data-testid="invalid-project-empty"');
  });
});
