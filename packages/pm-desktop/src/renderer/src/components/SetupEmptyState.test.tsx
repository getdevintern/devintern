import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupBanner, Welcome } from "./SetupEmptyState.tsx";

const noop = () => {};

describe("Welcome", () => {
  test("explains in-app setup and offers choose-directory CTA", () => {
    const html = renderToStaticMarkup(
      createElement(Welcome, { onChooseProject: noop, loading: false }),
    );
    expect(html).toContain('data-testid="welcome-screen"');
    expect(html).toContain("finish setup");
    expect(html).toContain("Choose project directory");
    expect(html).not.toContain("devpm init");
  });
});

describe("SetupBanner", () => {
  test("offers in-app setup as the primary path", () => {
    const html = renderToStaticMarkup(createElement(SetupBanner, { onSetup: noop }));
    expect(html).toContain('data-testid="setup-banner"');
    expect(html).toContain('data-testid="setup-banner-cta"');
    expect(html).toContain("Set up project");
    expect(html).toContain("Connect a task tracker");
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
