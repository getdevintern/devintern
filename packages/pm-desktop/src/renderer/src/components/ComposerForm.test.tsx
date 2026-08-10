import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerForm, initialComposerValues } from "./ComposerForm.tsx";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";

const noop = () => {};

function render(status: ProjectStatus, options?: { labelsError?: string | null }): string {
  return renderToStaticMarkup(
    createElement(ComposerForm, {
      status,
      values: {
        ...initialComposerValues,
        sourceContent: { ...initialComposerValues.sourceContent, prompt: "Ship labels" },
        labels: ["bug"],
      },
      onChange: noop,
      onGenerate: noop,
      busy: false,
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
