import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CODE_PRODUCT_URL } from "../../../shared/code-discovery.ts";
import { initialOutputState } from "../state/app-store.ts";
import type { OutputState } from "../state/app-store.ts";
import { createTicketWorkspace } from "../state/ticket-workspaces.ts";
import type { TicketWorkspace } from "../state/ticket-workspaces.ts";
import {
  resetTicketWorkspacesStore,
  useTicketWorkspacesStore,
} from "../state/ticket-workspaces-store.ts";
import { resetProjectStore, useProjectStore } from "../state/project-store.ts";
import { initialComposerValues } from "./ComposerForm.tsx";
import { CodeDiscoveryCard } from "./CodeDiscoveryCard.tsx";
import { OutputPanel } from "./OutputPanel.tsx";
import { TicketSidebar } from "./TicketSidebar.tsx";

const noop = () => {};

function renderDiscovery(
  variant: "card" | "sidebar" | "post-create",
  dismissError?: string,
): string {
  return renderToStaticMarkup(
    createElement(CodeDiscoveryCard, {
      variant,
      onLearnMore: noop,
      onDismiss: noop,
      dismissError: dismissError ?? null,
    }),
  );
}

describe("CodeDiscoveryCard variants", () => {
  test("card variant uses empty-state test id", () => {
    const html = renderDiscovery("card");
    expect(html).toContain('data-testid="code-discovery-card"');
    expect(html).toContain('data-testid="code-discovery-learn-more"');
    expect(html).toContain('data-testid="code-discovery-dismiss"');
  });

  test("sidebar variant uses compact footer test id", () => {
    const html = renderDiscovery("sidebar");
    expect(html).toContain('data-testid="code-discovery-sidebar"');
    expect(html).toContain("See how");
    expect(html).not.toContain("code-discovery-card");
  });

  test("post-create variant contrasts desk work with overnight Code", () => {
    const html = renderDiscovery("post-create");
    expect(html).toContain('data-testid="code-discovery-post-create"');
    expect(html).toContain("You just filed this at the desk");
    expect(html).toContain("overnight");
  });

  test("dismiss error renders on every variant", () => {
    for (const variant of ["card", "sidebar", "post-create"] as const) {
      const html = renderDiscovery(variant, "EACCES");
      expect(html).toContain('data-testid="code-discovery-dismiss-error"');
      expect(html).toContain("EACCES");
    }
  });
});

describe("TicketSidebar code discovery", () => {
  const ticket: TicketWorkspace = createTicketWorkspace("t1", {
    ...initialComposerValues,
    sourceContent: { ...initialComposerValues.sourceContent },
    projectKey: "DEV",
  });

  beforeEach(() => {
    resetTicketWorkspacesStore();
    useTicketWorkspacesStore.setState({ tickets: [ticket], activeTicketId: ticket.id });
  });
  afterEach(() => resetTicketWorkspacesStore());

  function renderSidebar(show: boolean, canOpenTicket = true): string {
    return renderToStaticMarkup(
      createElement(TicketSidebar, {
        onOpenTicket: noop,
        canOpenTicket,
        onCloseTicket: noop,
        showCodeDiscovery: show,
        onLearnMoreCode: show ? noop : undefined,
        onDismissCodeDiscovery: show ? noop : undefined,
      }),
    );
  }

  test("disables New when canOpenTicket is false", () => {
    const html = renderSidebar(false, false);
    expect(html).toContain('data-testid="open-ticket"');
    expect(html).toContain("disabled");
    expect(html).toContain("Finish project setup before opening a ticket");
  });

  test("shows sidebar discovery strip when eligible", () => {
    const html = renderSidebar(true);
    expect(html).toContain('data-testid="code-discovery-sidebar"');
    expect(html).toContain('data-testid="code-discovery-learn-more"');
  });

  test("hides sidebar discovery strip when not eligible", () => {
    const html = renderSidebar(false);
    expect(html).not.toContain("code-discovery-sidebar");
  });
});

describe("OutputPanel post-create code discovery", () => {
  const doneOutput: OutputState = {
    ...initialOutputState,
    phase: "done",
    created: {
      key: "DEV-1",
      url: "https://example.com/DEV-1",
      epicLinked: false,
      labelsApplied: false,
      attachmentsUploaded: 0,
    },
  };

  function seedTicket(output: OutputState): TicketWorkspace {
    const t = createTicketWorkspace("out-1", {
      ...initialComposerValues,
      sourceContent: { ...initialComposerValues.sourceContent },
      issueType: "Task",
      decompose: false,
    });
    return { ...t, output };
  }

  beforeEach(() => {
    resetProjectStore();
    resetTicketWorkspacesStore();
    useProjectStore.setState({ loadingProject: false, updatingFromRemote: false });
  });
  afterEach(() => {
    resetProjectStore();
    resetTicketWorkspacesStore();
  });

  function renderOutput(show: boolean, output: OutputState = doneOutput): string {
    const ticket = seedTicket(output);
    useTicketWorkspacesStore.setState({ tickets: [ticket], activeTicketId: ticket.id });
    return renderToStaticMarkup(
      createElement(OutputPanel, {
        onEdit: noop,
        onCreate: noop,
        onCreateSubtasks: noop,
        onOpenUrl: noop,
        showCodeDiscovery: show,
        onLearnMoreCode: show ? noop : undefined,
        onDismissCodeDiscovery: show ? noop : undefined,
      }),
    );
  }

  test("shows labels apply failure without hiding the created task", () => {
    const failingOutput: OutputState = {
      ...doneOutput,
      created: { ...doneOutput.created!, labelsApplyError: "permission denied" },
    };
    const html = renderOutput(false, failingOutput);
    expect(html).toContain("Task created: DEV-1");
    expect(html).toContain("Labels failed: permission denied");
  });

  test("shows post-create tip after successful create when eligible", () => {
    const html = renderOutput(true);
    expect(html).toContain("Task created: DEV-1");
    expect(html).toContain('data-testid="code-discovery-post-create"');
  });

  test("hides post-create tip when not eligible", () => {
    const html = renderOutput(false);
    expect(html).toContain("Task created: DEV-1");
    expect(html).not.toContain("code-discovery-post-create");
  });
});

describe("CODE_PRODUCT_URL used by discovery CTAs", () => {
  test("is the founders outcome page", () => {
    expect(CODE_PRODUCT_URL).toContain("/for/founders/");
  });
});
