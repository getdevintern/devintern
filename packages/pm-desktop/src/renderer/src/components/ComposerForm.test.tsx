import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerForm, initialComposerValues } from "./ComposerForm.tsx";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";
import { resetProjectStore, useProjectStore } from "../state/project-store.ts";
import {
  resetTicketWorkspacesStore,
  useTicketWorkspacesStore,
} from "../state/ticket-workspaces-store.ts";
import { createTicketWorkspace } from "../state/ticket-workspaces.ts";

const noop = () => {};

function render(status: ProjectStatus, options?: { labelsError?: string | null }): string {
  // Seed the active ticket with the composer values the form previously received as props.
  const ticket = createTicketWorkspace("composer-1", {
    ...initialComposerValues,
    sourceContent: { ...initialComposerValues.sourceContent, prompt: "Ship labels" },
    labels: ["bug"],
  });
  useTicketWorkspacesStore.setState({ tickets: [ticket], activeTicketId: ticket.id });
  useProjectStore.setState({
    status,
    loadingProject: false,
    updatingFromRemote: false,
    chromeError: null,
  });
  return renderToStaticMarkup(
    createElement(ComposerForm, {
      onGenerate: noop,
      issueTypes: ["Task", "Bug"],
      loadingIssueTypes: false,
      labels: [
        { id: "bug", name: "bug" },
        { id: "backend", name: "backend" },
      ],
      loadingLabels: false,
      labelsError: options?.labelsError ?? null,
      onRetryLabels: noop,
    }),
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

describe("ComposerForm labels field", () => {
  test("shows Labels when the active tracker supports them", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      supportsLabels: true,
      supportsIssueTypes: true,
      supportsEpicLinking: true,
    });
    expect(html).toContain("Labels (optional)");
    expect(html).toContain("bug");
    expect(html).toContain('data-slot="combobox-chip"');
  });

  test("hides Labels when the tracker does not support them", () => {
    const html = render({
      projectDir: "/repo",
      configured: true,
      isGitRepository: true,
      supportsLabels: false,
      supportsIssueTypes: true,
      supportsEpicLinking: false,
    });
    expect(html).not.toContain("Labels (optional)");
    expect(html).not.toContain('data-slot="combobox-chip"');
  });

  test("surfaces a recoverable labels load error", () => {
    const html = render(
      {
        projectDir: "/repo",
        configured: true,
        isGitRepository: true,
        supportsLabels: true,
      },
      { labelsError: "rate limited" },
    );
    expect(html).toContain("Failed to load labels: rate limited");
    expect(html).toContain("Retry");
  });
});
