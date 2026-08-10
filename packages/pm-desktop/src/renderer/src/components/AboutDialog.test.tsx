import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ABOUT_PRODUCT_NAME, ABOUT_WEBSITE_URL } from "../../../shared/about.ts";

mock.module("@/components/ui/dialog", () => {
  const React = require("react");
  const passthrough =
    (Tag: "div" | "h2") =>
    ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children?: ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) =>
      React.createElement(Tag, props, children);

  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? React.createElement("div", { "data-testid": "dialog-root" }, children) : null,
    // Keep the mock export surface aligned with ui/dialog so later suites that
    // import DialogTrigger/Portal/Close/Overlay aren't broken by mock.module.
    DialogTrigger: passthrough("div"),
    DialogPortal: passthrough("div"),
    DialogClose: passthrough("div"),
    DialogOverlay: passthrough("div"),
    DialogContent: passthrough("div"),
    DialogHeader: passthrough("div"),
    DialogFooter: passthrough("div"),
    DialogTitle: passthrough("h2"),
    DialogDescription: passthrough("div"),
  };
});

const { ABOUT_VERSION_UNAVAILABLE, AboutDialog, formatAboutVersion } =
  await import("./AboutDialog.tsx");

describe("formatAboutVersion", () => {
  test("includes the installed version when available", () => {
    expect(formatAboutVersion("0.2.0")).toBe("Version 0.2.0");
  });

  test("shows a loading placeholder when version is not yet available", () => {
    expect(formatAboutVersion(null)).toBe("Version …");
  });

  test("shows unavailable when version IPC failed", () => {
    expect(formatAboutVersion(ABOUT_VERSION_UNAVAILABLE)).toBe("Version unavailable");
  });
});

describe("AboutDialog", () => {
  function renderAbout(
    props: Partial<{
      open: boolean;
      version: string | null;
      onOpenWebsite: (url: string) => void;
    }> = {},
  ): string {
    return renderToStaticMarkup(
      createElement(AboutDialog, {
        open: props.open ?? true,
        onOpenChange: () => {},
        version: props.version ?? "0.2.0",
        onOpenWebsite: props.onOpenWebsite ?? (() => {}),
      }),
    );
  }

  test("renders title, app name, version, and website control when open", () => {
    const html = renderAbout({ version: "1.0.0" });
    expect(html).toContain('data-testid="about-dialog"');
    expect(html).toContain('data-testid="about-dialog-title"');
    expect(html).toContain(`About ${ABOUT_PRODUCT_NAME}`);
    expect(html).toContain('data-testid="about-dialog-app-name"');
    expect(html).toContain("devintern");
    expect(html).toContain(">pm<");
    expect(html).not.toContain("DevIntern PM");
    expect(html).toContain('data-testid="about-dialog-version"');
    expect(html).toContain("Version 1.0.0");
    expect(html).toContain('data-testid="about-dialog-website"');
    expect(html).toContain("Visit website");
    expect(html).toContain('data-testid="about-dialog-check-updates"');
    expect(html).toContain("Check for updates");
    expect(html).toContain('data-testid="about-dialog-close"');
  });

  describe("website button", () => {
    let domWindow: Window;
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      domWindow = new Window();
      const { document } = domWindow;
      globalThis.document = document as unknown as Document;
      globalThis.window = domWindow as unknown as Window & typeof globalThis.window;
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

      container = document.createElement("div") as unknown as HTMLDivElement;
      document.body.appendChild(
        container as unknown as Parameters<typeof document.body.appendChild>[0],
      );
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      // @ts-expect-error test teardown
      delete globalThis.document;
      // @ts-expect-error test teardown
      delete globalThis.window;
      domWindow.close();
    });

    test("calls onOpenWebsite with the public homepage URL", () => {
      const onOpenWebsite = mock(() => {});
      act(() => {
        root.render(
          createElement(AboutDialog, {
            open: true,
            onOpenChange: () => {},
            version: "0.2.0",
            onOpenWebsite,
          }),
        );
      });

      const button = domWindow.document.querySelector('[data-testid="about-dialog-website"]');
      expect(button).not.toBeNull();
      act(() => {
        button!.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
      });

      expect(onOpenWebsite).toHaveBeenCalledTimes(1);
      expect(onOpenWebsite).toHaveBeenCalledWith(ABOUT_WEBSITE_URL);
    });
  });
});
