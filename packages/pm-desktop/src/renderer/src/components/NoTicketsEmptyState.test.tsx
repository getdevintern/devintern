import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldShowCodeDiscovery } from "../../../shared/code-discovery.ts";
import { NoTicketsEmptyState } from "./NoTicketsEmptyState.tsx";

function renderEmptyState(props: Partial<Parameters<typeof NoTicketsEmptyState>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(NoTicketsEmptyState, {
      onOpenTicket: props.onOpenTicket ?? (() => {}),
      canOpenTicket: props.canOpenTicket,
      showCodeDiscovery: props.showCodeDiscovery,
      onLearnMoreCode: props.onLearnMoreCode ?? (() => {}),
      onDismissCodeDiscovery: props.onDismissCodeDiscovery ?? (() => {}),
      codeDiscoveryDismissError: props.codeDiscoveryDismissError,
    }),
  );
}

describe("NoTicketsEmptyState code discovery wiring", () => {
  test("disables open CTA when canOpenTicket is false", () => {
    const html = renderEmptyState({ canOpenTicket: false });
    expect(html).toContain('data-testid="open-first-ticket"');
    expect(html).toContain("disabled");
    expect(html).toContain("Finish project setup before opening a ticket");
  });

  test("hides the discovery card by default", () => {
    const html = renderEmptyState();
    expect(html).toContain('data-testid="no-tickets-empty"');
    expect(html).not.toContain("code-discovery-card");
  });

  test("shows the discovery card when shouldShowCodeDiscovery is true", () => {
    const show = shouldShowCodeDiscovery({
      configured: true,
      hasCodeConfig: false,
      dismissed: false,
    });
    const html = renderEmptyState({ showCodeDiscovery: show });
    expect(html).toContain('data-testid="code-discovery-card"');
    expect(html).toContain('data-testid="code-discovery-dismiss"');
    expect(html).toContain('data-testid="code-discovery-learn-more"');
    expect(html).not.toContain("code-discovery-dismiss-error");
  });

  test("hides the discovery card when shouldShowCodeDiscovery is false", () => {
    const show = shouldShowCodeDiscovery({
      configured: true,
      hasCodeConfig: true,
      dismissed: false,
    });
    const html = renderEmptyState({ showCodeDiscovery: show });
    expect(html).not.toContain("code-discovery-card");
  });

  test("renders dismiss error when persistence failed", () => {
    const html = renderEmptyState({
      showCodeDiscovery: true,
      codeDiscoveryDismissError: "EACCES: permission denied",
    });
    expect(html).toContain('data-testid="code-discovery-dismiss-error"');
    expect(html).toContain("EACCES: permission denied");
    expect(html).toMatch(/Couldn(?:'|&#x27;)t save preference/);
  });
});
