import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ProjectStatus } from "../../../shared/ipc-contract.ts";
import { ComposerForm } from "./ComposerForm.tsx";
import { resetProjectStore, useProjectStore } from "../state/project-store.ts";
import {
  resetTicketWorkspacesStore,
  useTicketWorkspacesStore,
} from "../state/ticket-workspaces-store.ts";
import { createTicketWorkspace } from "../state/ticket-workspaces.ts";

const noop = () => {};

const status: ProjectStatus = {
  projectDir: "/repo",
  configured: true,
  isGitRepository: true,
  supportsLabels: false,
  supportsIssueTypes: true,
  supportsEpicLinking: false,
};

describe("ComposerForm quick-capture focus signal", () => {
  let domWindow: Window;
  let container: HTMLDivElement;
  let root: Root;

  function seedTicket(): void {
    const ticket = createTicketWorkspace("composer-focus-1");
    useTicketWorkspacesStore.setState({ tickets: [ticket], activeTicketId: ticket.id });
    useProjectStore.setState({
      status,
      loadingProject: false,
      updatingFromRemote: false,
      chromeError: null,
    });
  }

  function renderForm(focusEditorSignal: number): void {
    seedTicket();
    act(() => {
      root.render(
        createElement(ComposerForm, {
          onGenerate: noop,
          issueTypes: ["Task"],
          loadingIssueTypes: false,
          labels: [],
          loadingLabels: false,
          labelsError: null,
          focusEditorSignal,
        }),
      );
    });
  }

  beforeEach(() => {
    domWindow = new Window();
    globalThis.document = domWindow.document as unknown as Document;
    globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
    // Some UI primitives reference element constructors at render time.
    for (const key of [
      "Element",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLFormElement",
      "HTMLButtonElement",
      "Node",
    ] as const) {
      (globalThis as Record<string, unknown>)[key] = (
        domWindow as unknown as Record<string, unknown>
      )[key];
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.appendChild(
      container as unknown as Parameters<typeof domWindow.document.body.appendChild>[0],
    );
    root = createRoot(container);
    resetProjectStore();
    resetTicketWorkspacesStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetProjectStore();
    resetTicketWorkspacesStore();
    // @ts-expect-error test teardown
    delete globalThis.document;
    // @ts-expect-error test teardown
    delete globalThis.window;
    for (const key of [
      "Element",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLFormElement",
      "HTMLButtonElement",
      "Node",
    ] as const) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    domWindow.close();
  });

  test("no focus without a signal bump", () => {
    renderForm(0);
    expect(domWindow.document.activeElement?.nodeName).not.toBe("TEXTAREA");
  });

  test("signal bump focuses the prompt textarea", () => {
    renderForm(0);
    act(() => {
      root.render(
        createElement(ComposerForm, {
          onGenerate: noop,
          issueTypes: ["Task"],
          loadingIssueTypes: false,
          labels: [],
          loadingLabels: false,
          labelsError: null,
          focusEditorSignal: 1,
        }),
      );
    });
    expect(domWindow.document.activeElement?.getAttribute("data-slot")).toBe("textarea");
  });

  test("figma tab focuses the URL input on the next signal", () => {
    renderForm(0);
    act(() => {
      useTicketWorkspacesStore
        .getState()
        .patchComposer("composer-focus-1", { sourceType: "figma" });
    });
    act(() => {
      root.render(
        createElement(ComposerForm, {
          onGenerate: noop,
          issueTypes: ["Task"],
          loadingIssueTypes: false,
          labels: [],
          loadingLabels: false,
          labelsError: null,
          focusEditorSignal: 2,
        }),
      );
    });
    expect(domWindow.document.activeElement?.getAttribute("data-slot")).toBe("input");
  });
});
